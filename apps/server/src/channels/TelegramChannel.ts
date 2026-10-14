import {
  BotTelegramError,
  type BotTelegramStatus,
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type ProjectId,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type RunId,
  type RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  classifyTelegramMessage,
  formatApprovalPrompt,
  formatQuestion,
  parseApprovalReply,
  parseQuestionReply,
  splitTelegramText,
  type TelegramQuestion,
} from "./telegramLogic.ts";

/** Long-poll window Telegram holds a getUpdates request open for, in seconds. */
const POLL_SECONDS = 50;
/** How long a reply may take before the chat is told the bot is still working. */
const REPLY_TIMEOUT_MS = 30 * 60_000;
const REGISTRY_SECRET = "telegram-bots";

const BotState = Schema.Struct({
  token: Schema.String,
  username: Schema.String,
  ownerUserId: Schema.NullOr(Schema.Number),
  pairingCode: Schema.String,
  offset: Schema.Number,
  /** The MyBot thread each Telegram chat continues. */
  threads: Schema.Record(Schema.String, Schema.String),
});
type BotState = typeof BotState.Type;
const BotStateJson = Schema.fromJsonString(BotState);
const RegistryJson = Schema.fromJsonString(Schema.Array(Schema.String));

const TelegramUser = Schema.Struct({ id: Schema.Number, username: Schema.optional(Schema.String) });
const TelegramUpdate = Schema.Struct({
  update_id: Schema.Number,
  message: Schema.optional(
    Schema.Struct({
      chat: Schema.Struct({ id: Schema.Number, type: Schema.String }),
      from: Schema.optional(TelegramUser),
      text: Schema.optional(Schema.String),
    }),
  ),
});
type TelegramUpdate = typeof TelegramUpdate.Type;
const telegramResponse = <A, I>(result: Schema.Codec<A, I>) =>
  Schema.Struct({
    ok: Schema.Boolean,
    result: Schema.optional(result),
    description: Schema.optional(Schema.String),
    error_code: Schema.optional(Schema.Number),
  });

const secretName = (projectId: ProjectId) => `telegram-bot-${projectId}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class TelegramChannel extends Context.Service<
  TelegramChannel,
  {
    readonly status: (projectId: ProjectId) => Effect.Effect<BotTelegramStatus, BotTelegramError>;
    /** Checks the token with Telegram, saves it, and starts listening for messages. */
    readonly connect: (
      projectId: ProjectId,
      token: string,
    ) => Effect.Effect<BotTelegramStatus, BotTelegramError>;
    readonly disconnect: (
      projectId: ProjectId,
    ) => Effect.Effect<BotTelegramStatus, BotTelegramError>;
  }
>()("t3/channels/TelegramChannel") {}

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const listeners = yield* FiberMap.make<ProjectId>();
  /** Each connected bot's state, persisted after every change. */
  const states = new Map<ProjectId, SynchronizedRef.SynchronizedRef<BotState>>();

  const fail = (message: string) => () => new BotTelegramError({ message });

  const call = <A, I>(
    token: string,
    method: string,
    body: Record<string, unknown>,
    result: Schema.Codec<A, I>,
  ) =>
    http
      .execute(
        HttpClientRequest.post(`https://api.telegram.org/bot${token}/${method}`).pipe(
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(telegramResponse(result))),
        Effect.timeout(`${POLL_SECONDS + 15} seconds`),
        Effect.mapError(fail(`Telegram ${method} failed.`)),
        Effect.flatMap((response) =>
          response.ok && response.result !== undefined
            ? Effect.succeed(response.result)
            : Effect.fail(
                new BotTelegramError({
                  message: response.description ?? `Telegram ${method} was rejected.`,
                }),
              ),
        ),
      );

  const send = (token: string, chatId: number, text: string) =>
    Effect.forEach(
      splitTelegramText(text),
      (chunk) => call(token, "sendMessage", { chat_id: chatId, text: chunk }, Schema.Unknown),
      { discard: true },
    );

  const readSecret = (name: string) =>
    secrets
      .get(name)
      .pipe(
        Effect.map(Option.map((bytes) => decoder.decode(bytes))),
        Effect.mapError(fail("Could not read Telegram settings.")),
      );
  const writeSecret = (name: string, value: string) =>
    secrets
      .set(name, encoder.encode(value))
      .pipe(Effect.mapError(fail("Could not save Telegram settings.")));

  const readRegistry = readSecret(REGISTRY_SECRET).pipe(
    Effect.map((json) =>
      Option.match(json, {
        onNone: () => [],
        onSome: (value) =>
          Option.getOrElse(Schema.decodeUnknownOption(RegistryJson)(value), () => []),
      }),
    ),
  );
  const writeRegistry = (projectIds: ReadonlyArray<string>) =>
    writeSecret(REGISTRY_SECRET, Schema.encodeSync(RegistryJson)([...new Set(projectIds)]));

  const readState = (projectId: ProjectId) =>
    readSecret(secretName(projectId)).pipe(
      Effect.map(Option.flatMap((value) => Schema.decodeUnknownOption(BotStateJson)(value))),
    );
  const saveState = (projectId: ProjectId, state: BotState) =>
    writeSecret(secretName(projectId), Schema.encodeSync(BotStateJson)(state));
  const updateState = (projectId: ProjectId, f: (state: BotState) => BotState) => {
    const ref = states.get(projectId);
    if (ref === undefined) return Effect.void;
    return SynchronizedRef.updateEffect(ref, (state) => {
      const next = f(state);
      return saveState(projectId, next).pipe(Effect.as(next));
    }).pipe(Effect.ignore);
  };

  const toStatus = (state: Option.Option<BotState>): BotTelegramStatus =>
    Option.match(state, {
      onNone: () => ({ connected: false, username: null, paired: false, pairingCode: null }),
      onSome: (bot) => ({
        connected: true,
        username: bot.username,
        paired: bot.ownerUserId !== null,
        pairingCode: bot.ownerUserId === null ? bot.pairingCode : null,
      }),
    });

  /** Sends the owner's message into the chat's thread and returns the run to wait on. */
  const deliver = Effect.fn("TelegramChannel.deliver")(function* (
    projectId: ProjectId,
    chatId: number,
    updateId: number,
    text: string,
  ) {
    const state = yield* SynchronizedRef.get(states.get(projectId)!);
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.map(Option.getOrUndefined), Effect.mapError(fail("Could not read the bot.")));
    if (project === undefined)
      return yield* new BotTelegramError({ message: "The bot no longer exists." });
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(fail("Could not read settings.")),
    );
    const resolved = resolveProjectSettings(settings, projectId, project).settings;
    const key = `telegram:${projectId}:${updateId}`;
    let threadId = state.threads[String(chatId)];
    if (threadId === undefined) {
      if (resolved.defaultModelSelection === null) {
        return yield* new BotTelegramError({
          message: "Pick a model for this bot in MyBot first.",
        });
      }
      const launched = yield* threadLaunch
        .launch({
          commandId: CommandId.make(`${key}:thread`),
          projectId,
          title: "Telegram",
          modelSelection: resolved.defaultModelSelection,
          runtimeMode: resolved.defaultRuntimeMode,
          interactionMode: "default",
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError(fail("Could not start a conversation.")));
      threadId = launched.threadId;
      const startedThreadId = threadId;
      yield* updateState(projectId, (current) => ({
        ...current,
        threads: { ...current.threads, [String(chatId)]: startedThreadId },
      }));
    }
    const sent = yield* threadManagement
      .sendToThread({
        projectId,
        commandId: CommandId.make(key),
        threadId: ThreadId.make(threadId),
        messageId: MessageId.make(key),
        text,
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.mapError(fail("Could not send the message.")));
    return { threadId: ThreadId.make(threadId), runId: sent.run.id };
  });

  /** The approval or question a chat's next message answers. */
  type PendingAnswer =
    | {
        readonly kind: "approval";
        readonly threadId: ThreadId;
        readonly requestId: RuntimeRequestId;
      }
    | {
        readonly kind: "question";
        readonly threadId: ThreadId;
        readonly requestId: RuntimeRequestId;
        readonly questionId: string;
        readonly question: TelegramQuestion;
      };
  const pendingAnswers = new Map<string, PendingAnswer>();
  const chatKey = (projectId: ProjectId, chatId: number) => `${projectId}:${chatId}`;

  const typing = (token: string, chatId: number) =>
    call(token, "sendChatAction", { chat_id: chatId, action: "typing" }, Schema.Unknown).pipe(
      Effect.ignore,
      Effect.repeat(Schedule.spaced("4 seconds")),
      Effect.andThen(Effect.never),
    );

  /** Tells the chat about a request the run stopped on and remembers what answers it. */
  const askInChat = Effect.fn("TelegramChannel.askInChat")(function* (
    projectId: ProjectId,
    chatId: number,
    token: string,
    threadId: ThreadId,
    request: OrchestrationV2RuntimeRequest,
  ) {
    const records = yield* threadManagement
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["approval_request", "user_input_request"],
      })
      .pipe(Effect.mapError(fail("Could not read what the bot is asking.")));
    const item = records.turnItems.find(
      (candidate) =>
        (candidate.type === "approval_request" || candidate.type === "user_input_request") &&
        candidate.requestId === request.id,
    );
    const key = chatKey(projectId, chatId);
    if (item?.type === "approval_request") {
      pendingAnswers.set(key, { kind: "approval", threadId, requestId: request.id });
      return yield* send(
        token,
        chatId,
        formatApprovalPrompt({ title: item.title, prompt: item.prompt }),
      );
    }
    const question = item?.type === "user_input_request" ? item.questions : [];
    if (question.length === 1) {
      pendingAnswers.set(key, {
        kind: "question",
        threadId,
        requestId: request.id,
        questionId: question[0]!.id,
        question: question[0]!,
      });
      return yield* send(token, chatId, formatQuestion(question[0]!));
    }
    return yield* send(
      token,
      chatId,
      "The bot is waiting on you. Open the conversation in MyBot to answer.",
    );
  });

  /** The reply to send once a run has ended. */
  const finalReply = Effect.fn("TelegramChannel.finalReply")(function* (
    threadId: ThreadId,
    runId: RunId,
    waited: ThreadManagementService.ThreadManagementWaitResult,
  ) {
    if (waited.timedOut) return "Still working on it. Check MyBot for the result.";
    const records = yield* threadManagement
      .getThreadRecords(threadId, ["messages"], {
        messageRoles: ["assistant"],
        messageRunIds: [runId],
      })
      .pipe(Effect.mapError(fail("Could not read the reply.")));
    const last = records.messages
      .filter((message) => !message.streaming && message.text.trim().length > 0)
      .toSorted((a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt))
      .at(-1);
    if (last) return last.text;
    return waited.run?.status === "completed"
      ? "Done."
      : `The run ended as ${waited.run?.status ?? "unknown"}. Check MyBot for details.`;
  });

  /**
   * Follows a run to its end and returns its reply. Each approval or question
   * it stops on goes to the chat; typing shows only while the bot is working,
   * not while it waits on the user.
   */
  const followRun = Effect.fn("TelegramChannel.followRun")(function* (
    projectId: ProjectId,
    chatId: number,
    token: string,
    threadId: ThreadId,
    runId: RunId,
  ) {
    const asked = new Set<string>();
    const key = chatKey(projectId, chatId);
    while (true) {
      const ended = threadManagement
        .waitForThread({ projectId, threadId, runId, timeoutMs: REPLY_TIMEOUT_MS })
        .pipe(Effect.map((waited) => ({ type: "ended" as const, waited })));
      const stopped = threadManagement
        .waitForPendingRequest({ projectId, threadId, ignore: asked, timeoutMs: REPLY_TIMEOUT_MS })
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.never,
              onSome: (request) => Effect.succeed({ type: "request" as const, request }),
            }),
          ),
        );
      const outcome = yield* Effect.raceFirst(ended, stopped).pipe(
        pendingAnswers.has(key) ? (effect) => effect : Effect.raceFirst(typing(token, chatId)),
        Effect.mapError(fail("Could not follow the conversation.")),
      );
      if (outcome.type === "request") {
        asked.add(outcome.request.id);
        yield* askInChat(projectId, chatId, token, threadId, outcome.request);
        continue;
      }
      if (pendingAnswers.get(key)?.threadId === threadId) pendingAnswers.delete(key);
      return yield* finalReply(threadId, runId, outcome.waited);
    }
  });

  /** Answers the request the chat is waiting on; false when the message is not an answer to send. */
  const answerPending = Effect.fn("TelegramChannel.answerPending")(function* (
    projectId: ProjectId,
    chatId: number,
    token: string,
    updateId: number,
    text: string,
  ) {
    const key = chatKey(projectId, chatId);
    const pending = pendingAnswers.get(key);
    if (pending === undefined) return false;
    const response: Option.Option<{
      readonly decision?: ProviderApprovalDecision;
      readonly answers?: ProviderUserInputAnswers;
    }> =
      pending.kind === "approval"
        ? Option.map(Option.fromNullOr(parseApprovalReply(text)), (decision) => ({ decision }))
        : Option.map(Option.fromNullOr(parseQuestionReply(pending.question, text)), (answer) => ({
            answers: { [pending.questionId]: answer },
          }));
    if (Option.isNone(response)) {
      yield* send(
        token,
        chatId,
        pending.kind === "approval"
          ? "Reply yes, always, or no."
          : "That doesn't answer the question. Reply with one of the numbers.",
      );
      return true;
    }
    pendingAnswers.delete(key);
    // Acknowledge first: once answered, the run can finish and reply at once.
    yield* send(token, chatId, "Got it.");
    const sent = yield* threadManagement
      .dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`telegram:${projectId}:${updateId}`),
        threadId: pending.threadId,
        requestId: pending.requestId,
        ...response.value,
      })
      .pipe(Effect.result);
    // Answered in MyBot meanwhile: the message is an ordinary one after all.
    return sent._tag === "Success";
  });

  /** Sends a finished routine run's result to its bot's paired chat. */
  const forwardRoutineResult = Effect.fn("TelegramChannel.forwardRoutineResult")(function* (
    run: OrchestrationV2Run,
  ) {
    const thread = yield* threadManagement.getThreadShell(run.threadId);
    const ref = thread === null ? undefined : states.get(thread.projectId);
    if (thread === null || ref === undefined) return;
    const state = yield* SynchronizedRef.get(ref);
    if (state.ownerUserId === null) return;
    const records = yield* threadManagement.getThreadRecords(run.threadId, ["messages"], {
      messageIds: [run.userMessageId],
    });
    if (!records.messages.some((message) => message.scheduledTaskId !== undefined)) return;
    const text = yield* finalReply(run.threadId, run.id, {
      threadId: run.threadId,
      run,
      timedOut: false,
    });
    // A private chat's id is its user's id.
    yield* send(state.token, state.ownerUserId, `${thread.title}\n\n${text}`);
  });

  const handleUpdate = Effect.fn("TelegramChannel.handleUpdate")(function* (
    projectId: ProjectId,
    update: TelegramUpdate,
  ) {
    const message = update.message;
    if (!message?.text || !message.from || message.chat.type !== "private") return;
    const chatId = message.chat.id;
    const state = yield* SynchronizedRef.get(states.get(projectId)!);
    const action = classifyTelegramMessage({
      ownerUserId: state.ownerUserId,
      pairingCode: state.pairingCode,
      fromUserId: message.from.id,
      text: message.text,
    });
    switch (action.type) {
      case "ignore":
        return;
      case "reject":
        return yield* send(state.token, chatId, "This bot is private. Pair it from MyBot first.");
      case "pair": {
        const ownerUserId = message.from.id;
        yield* updateState(projectId, (current) => ({ ...current, ownerUserId }));
        return yield* send(
          state.token,
          chatId,
          "Paired. Message me any time; /new starts a fresh conversation.",
        );
      }
      case "greet":
        return yield* send(
          state.token,
          chatId,
          "Hi! Message me any time; /new starts a fresh conversation.",
        );
      case "new-conversation":
        pendingAnswers.delete(chatKey(projectId, chatId));
        yield* updateState(projectId, (current) => {
          const { [String(chatId)]: _dropped, ...threads } = current.threads;
          return { ...current, threads };
        });
        return yield* send(state.token, chatId, "Started a new conversation.");
      case "deliver": {
        if (yield* answerPending(projectId, chatId, state.token, update.update_id, action.text))
          return;
        const text = yield* deliver(projectId, chatId, update.update_id, action.text).pipe(
          Effect.flatMap(({ threadId, runId }) =>
            followRun(projectId, chatId, state.token, threadId, runId),
          ),
          Effect.catch((error) => Effect.succeed(error.message)),
        );
        return yield* send(state.token, chatId, text);
      }
    }
  });

  /** Long-polls one bot's updates until it is disconnected. */
  const listen = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const ref = states.get(projectId);
      if (ref === undefined) return;
      const state = yield* SynchronizedRef.get(ref);
      const updates = yield* call(
        state.token,
        "getUpdates",
        { offset: state.offset, timeout: POLL_SECONDS, allowed_updates: ["message"] },
        Schema.Array(TelegramUpdate),
      );
      for (const update of updates) {
        // Advance first: a message is handled at most once, even across restarts.
        yield* updateState(projectId, (current) => ({ ...current, offset: update.update_id + 1 }));
        yield* handleUpdate(projectId, update).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Telegram message failed.", { cause })),
          Effect.forkDetach,
        );
      }
    }).pipe(
      Effect.tapError((error) => Effect.logWarning("Telegram polling failed.", { error })),
      Effect.retry(
        Schedule.exponential("2 seconds").pipe(
          Schedule.modifyDelay(({ duration }) =>
            Effect.succeed(Duration.min(duration, Duration.minutes(1))),
          ),
        ),
      ),
      Effect.forever,
    );

  const start = (projectId: ProjectId, state: BotState) =>
    Effect.gen(function* () {
      states.set(projectId, yield* SynchronizedRef.make(state));
      yield* FiberMap.run(listeners, projectId, listen(projectId));
    });

  const forwarded = new Set<string>();
  yield* orchestrator.streamDomainEvents.pipe(
    Stream.filter(
      (event) =>
        event.type === "run.updated" &&
        (event.payload.status === "completed" || event.payload.status === "failed"),
    ),
    Stream.runForEach((event) => {
      if (event.type !== "run.updated" || forwarded.has(event.payload.id)) return Effect.void;
      forwarded.add(event.payload.id);
      return forwardRoutineResult(event.payload).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Telegram routine result failed.", { cause }),
        ),
        Effect.forkDetach,
        Effect.asVoid,
      );
    }),
    Effect.catchCause((cause) => Effect.logWarning("Telegram routine results stopped.", { cause })),
    Effect.forkScoped,
  );

  for (const id of yield* readRegistry.pipe(Effect.orElseSucceed(() => []))) {
    const projectId = id as ProjectId;
    const state = yield* readState(projectId).pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(state)) yield* start(projectId, state.value);
  }

  return TelegramChannel.of({
    status: (projectId) =>
      Effect.suspend(() => {
        const ref = states.get(projectId);
        return ref === undefined
          ? Effect.succeed(toStatus(Option.none()))
          : SynchronizedRef.get(ref).pipe(Effect.map((state) => toStatus(Option.some(state))));
      }),
    connect: Effect.fn("TelegramChannel.connect")(function* (projectId, token) {
      const me = yield* call(token, "getMe", {}, TelegramUser).pipe(
        Effect.mapError(fail("Telegram did not accept that token. Copy it again from @BotFather.")),
      );
      const bytes = yield* crypto
        .randomBytes(4)
        .pipe(Effect.mapError(fail("Could not make a pairing code.")));
      const pairingCode = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
      const state: BotState = {
        token,
        username: me.username ?? "",
        ownerUserId: null,
        pairingCode,
        offset: 0,
        threads: {},
      };
      yield* FiberMap.remove(listeners, projectId);
      yield* saveState(projectId, state);
      yield* writeRegistry([...(yield* readRegistry), projectId]);
      yield* start(projectId, state);
      return toStatus(Option.some(state));
    }),
    disconnect: Effect.fn("TelegramChannel.disconnect")(function* (projectId) {
      yield* FiberMap.remove(listeners, projectId);
      states.delete(projectId);
      yield* secrets.remove(secretName(projectId)).pipe(Effect.ignore);
      yield* writeRegistry((yield* readRegistry).filter((id) => id !== projectId));
      return toStatus(Option.none());
    }),
  });
});

export const layer = Layer.effect(TelegramChannel, make);
