/**
 * BotMessaging - one bot asks another, through the `bot_message` MCP tool.
 *
 * Each sender and receiver pair has one standing conversation in the
 * receiving bot's project, so the receiver remembers earlier messages. It runs
 * as the receiving bot (its model, never broader modes than its own or the
 * sender's), and the sender usually waits for its final reply.
 *
 * @module BotMessaging
 */
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type ProjectId,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { runtimeModeRank } from "../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

/** How long a sender waits for a reply before it is told the receiver is still working. */
export const REPLY_TIMEOUT_MS = 20 * 60_000;
/** How many bots may wait on each other in one chain of messages. */
export const MAX_CHAIN_DEPTH = 4;
/** With Auto Review on, how long a request gets to be approved without the user. */
const AUTO_REVIEW_GRACE = "45 seconds";
/** Deleted or archived conversations a pair can skip before it gets an unnumbered one. */
const MAX_CONVERSATION_GENERATIONS = 50;

export class BotMessagingError extends Schema.TaggedError<BotMessagingError>()(
  "BotMessagingError",
  { message: Schema.String },
) {}

/** The calling thread, whose bot sends the message and whose modes cap the receiver's. */
export interface BotMessageSender {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly modelSelection: ModelSelection;
}

export interface BotMessageInput {
  readonly sender: BotMessageSender;
  /** The receiving bot's name (any case) or projectId. */
  readonly to: string;
  readonly message: string;
  /** Waits for the reply when true; otherwise returns once the message is delivered. */
  readonly wait: boolean;
}

export interface BotMessageResult {
  readonly to: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly status: "replied" | "delivered" | "waiting_on_user" | "still_working" | "failed";
  /** The receiving bot's final reply, when it replied. */
  readonly reply: string | null;
  /** What happened, in a sentence the sender can pass on to the user. */
  readonly note: string;
}

export class BotMessaging extends Context.Service<
  BotMessaging,
  {
    readonly send: (input: BotMessageInput) => Effect.Effect<BotMessageResult, BotMessagingError>;
  }
>()("mybot/bots/BotMessaging") {}

interface WaitEdge {
  readonly id: number;
  readonly from: ProjectId;
  readonly to: ProjectId;
}

/** Whether `to` reaches `from` through bots that are waiting on each other. */
const reaches = (edges: ReadonlyArray<WaitEdge>, start: ProjectId, target: ProjectId) => {
  const seen = new Set<ProjectId>();
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges) if (edge.from === current) pending.push(edge.to);
  }
  return false;
};

/** The longest chain of bots waiting, ending at `project`. */
const depthTo = (edges: ReadonlyArray<WaitEdge>, project: ProjectId): number => {
  const incoming = edges.filter((edge) => edge.to === project);
  return incoming.length === 0
    ? 0
    : 1 + Math.max(...incoming.map((edge) => depthTo(edges, edge.from)));
};

/** The thread ids a pair's conversation uses, oldest first; a deleted or archived one is skipped. */
export const conversationThreadId = (from: ProjectId, to: ProjectId, generation: number) =>
  ThreadId.make(`bot-message:${from}:${to}${generation === 1 ? "" : `:${generation}`}`);

const fail = (message: string) => new BotMessagingError({ message });

const make = Effect.gen(function* () {
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const edges = yield* SynchronizedRef.make<ReadonlyArray<WaitEdge>>([]);
  // Finding or starting a pair's conversation runs one at a time, so two
  // messages sent at once never both start it.
  const pairLocks = yield* KeyedLock.make<string>();
  let nextEdgeId = 0;

  const resolveTarget = Effect.fn("BotMessaging.resolveTarget")(function* (
    sender: OrchestrationProjectShell,
    to: string,
    bots: ReadonlyArray<OrchestrationProjectShell>,
  ) {
    const wanted = to.trim();
    const byId = bots.find((bot) => bot.id === wanted);
    const byName = bots.filter((bot) => bot.title.trim().toLowerCase() === wanted.toLowerCase());
    if (byId === undefined && byName.length > 1)
      return yield* fail(
        `More than one bot is named ${wanted}; pass its projectId instead: ${byName.map((bot) => bot.id).join(", ")}.`,
      );
    const target = byId ?? byName[0];
    const reachable = bots.filter((bot) => bot.bot?.members === undefined && bot.id !== sender.id);
    if (target === undefined)
      return yield* fail(
        `No bot is named ${wanted}. ${
          reachable.length === 0
            ? "The user has no other bots yet."
            : `You can message: ${reachable.map((bot) => bot.title).join(", ")}.`
        }`,
      );
    if (target.id === sender.id) return yield* fail("You can't message yourself.");
    if (target.bot?.members !== undefined)
      return yield* fail(
        `${target.title} is a group chat, which can't receive bot_message. Message its members instead.`,
      );
    return target;
  });

  /** The pair's current conversation, or the id a new one starts under. */
  const findConversation = Effect.fn("BotMessaging.findConversation")(function* (
    from: ProjectId,
    to: ProjectId,
  ) {
    for (let generation = 1; generation <= MAX_CONVERSATION_GENERATIONS; generation++) {
      const threadId = conversationThreadId(from, to, generation);
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(() => fail("Could not read the conversation.")));
      if (shell !== null) {
        if (shell.archivedAt === null && shell.projectId === to)
          return { threadId, existing: shell } as const;
        continue;
      }
      // A deleted thread has no shell but keeps its id, which a new thread must not reuse.
      const deleted = yield* threads.getThreadProjection(threadId).pipe(Effect.option);
      if (Option.isNone(deleted)) return { threadId, existing: null } as const;
    }
    const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    return { threadId: ThreadId.make(`bot-message:${from}:${to}:${id}`), existing: null } as const;
  });

  /** Delivers the message and returns the run that answers it. */
  const deliver = Effect.fn("BotMessaging.deliver")(function* (
    input: BotMessageInput,
    sender: OrchestrationProjectShell,
    target: OrchestrationProjectShell,
    text: string,
  ) {
    const key = `bot-message:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
    const messageId = MessageId.make(key);
    const conversation = yield* findConversation(sender.id, target.id);
    if (conversation.existing !== null) {
      // Like any other thread it changes, the conversation must run within the sender's modes.
      if (
        runtimeModeRank[conversation.existing.runtimeMode] >
        runtimeModeRank[input.sender.runtimeMode]
      )
        return yield* fail(
          `Your conversation with ${target.title} runs in ${conversation.existing.runtimeMode} mode, above yours, so you can't message it. Ask the user to lower it or archive that conversation.`,
        );
      const sent = yield* threads
        .sendToThread({
          projectId: target.id,
          commandId: CommandId.make(key),
          threadId: conversation.threadId,
          messageId,
          senderThreadId: input.sender.threadId,
          text,
          attachments: [],
          mode: "queue",
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(() => fail(`Could not deliver the message to ${target.title}.`)));
      return { threadId: conversation.threadId, runId: sent.run.id };
    }
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings.pipe(
        Effect.mapError(() => fail("Could not read settings.")),
      ),
      target.id,
      target,
    ).settings;
    // It runs as the receiving bot: on its model, and never with broader
    // permissions than its own or the sender's.
    const runtimeMode =
      runtimeModeRank[settings.defaultRuntimeMode] < runtimeModeRank[input.sender.runtimeMode]
        ? settings.defaultRuntimeMode
        : input.sender.runtimeMode;
    const launched = yield* threadLaunch
      .launch({
        commandId: CommandId.make(key),
        threadId: conversation.threadId,
        projectId: target.id,
        title: `Message from ${sender.title}`,
        modelSelection: settings.defaultModelSelection ?? input.sender.modelSelection,
        runtimeMode,
        interactionMode: input.sender.interactionMode,
        initialMessage: {
          messageId,
          senderThreadId: input.sender.threadId,
          text,
          attachments: [],
        },
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.mapError(() => fail(`Could not start a conversation with ${target.title}.`)));
    const run = launched.projection.runs.find((candidate) => candidate.userMessageId === messageId);
    if (run === undefined) return yield* fail(`Could not deliver the message to ${target.title}.`);
    return { threadId: launched.threadId, runId: run.id };
  });

  /** The run's last written reply. */
  const readReply = Effect.fn("BotMessaging.readReply")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    const records = yield* threads
      .getThreadRecords(threadId, ["messages"], {
        messageRoles: ["assistant"],
        messageRunIds: [runId],
      })
      .pipe(Effect.mapError(() => fail("Could not read the reply.")));
    return (
      records.messages
        .filter((message) => !message.streaming && message.text.trim().length > 0)
        .toSorted(
          (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
        )
        .at(-1)?.text ?? null
    );
  });

  const isPending = (threadId: ThreadId, requestId: string) =>
    threads.getThreadRecords(threadId, ["runtimeRequests"]).pipe(
      Effect.map((records) =>
        records.runtimeRequests.some(
          (request) => request.id === requestId && request.status === "pending",
        ),
      ),
      Effect.orElseSucceed(() => true),
    );

  /** Follows the answering run until it replies, stops on the user, or runs out of time. */
  const awaitReply = Effect.fn("BotMessaging.awaitReply")(function* (
    target: OrchestrationProjectShell,
    threadId: ThreadId,
    runId: RunId,
  ) {
    const result = (
      status: BotMessageResult["status"],
      note: string,
      reply: string | null = null,
    ): BotMessageResult => ({
      to: target.title,
      projectId: target.id,
      threadId,
      status,
      reply,
      note,
    });
    const settled = (waited: ThreadManagementService.ThreadManagementWaitResult) =>
      Effect.gen(function* () {
        if (waited.timedOut)
          return result(
            "still_working",
            `${target.title} is still working on it after ${REPLY_TIMEOUT_MS / 60_000} minutes. Its reply will be in its conversation, thread ${threadId}.`,
          );
        const reply = yield* readReply(threadId, runId);
        const status = waited.run?.status;
        if (status === "completed")
          return result(
            "replied",
            reply === null
              ? `${target.title} finished without a written reply.`
              : `${target.title} replied.`,
            reply,
          );
        return result(
          "failed",
          `${target.title}'s turn ended as ${status ?? "unknown"} before it replied.`,
          reply,
        );
      });
    const deadline = (yield* Clock.currentTimeMillis) + REPLY_TIMEOUT_MS;
    const handled = new Set<string>();
    const followFailed = () => fail(`Could not follow the conversation with ${target.title}.`);
    while (true) {
      const timeoutMs = Math.max(0, deadline - (yield* Clock.currentTimeMillis));
      const ended = threads
        .waitForThread({ projectId: target.id, threadId, runId, timeoutMs })
        .pipe(Effect.map((waited) => ({ type: "ended" as const, waited })));
      const stopped = threads
        .waitForPendingRequest({ projectId: target.id, threadId, ignore: handled, timeoutMs })
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.never,
              onSome: (request) => Effect.succeed({ type: "request" as const, request }),
            }),
          ),
        );
      const outcome = yield* Effect.raceFirst(ended, stopped).pipe(Effect.mapError(followFailed));
      if (outcome.type === "request") {
        handled.add(outcome.request.id);
        if (target.bot?.autoReview === true) {
          const graced = yield* Effect.raceFirst(
            ended,
            Effect.sleep(AUTO_REVIEW_GRACE).pipe(Effect.as({ type: "grace" as const })),
          ).pipe(Effect.mapError(followFailed));
          if (graced.type === "ended") return yield* settled(graced.waited);
          if (!(yield* isPending(threadId, outcome.request.id))) continue;
        }
        return result(
          "waiting_on_user",
          `${target.title} is waiting on the user (an approval or a question) in its conversation, thread ${threadId}. Tell the user to answer there; its reply will be in that conversation.`,
        );
      }
      return yield* settled(outcome.waited);
    }
  });

  /** Records that `from` waits on `to` while `effect` runs, refusing a loop or a long chain. */
  const whileWaiting = <A, E, R>(
    sender: OrchestrationProjectShell,
    target: OrchestrationProjectShell,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      SynchronizedRef.modifyEffect(edges, (current) => {
        if (reaches(current, target.id, sender.id))
          return Effect.fail(
            fail(
              `${target.title} is waiting on you; answer in your reply instead of messaging it.`,
            ),
          );
        if (depthTo(current, sender.id) + 1 > MAX_CHAIN_DEPTH)
          return Effect.fail(
            fail(
              `${MAX_CHAIN_DEPTH} bots are already waiting on each other in this chain; answer with what you have instead.`,
            ),
          );
        const edge = { id: nextEdgeId++, from: sender.id, to: target.id };
        return Effect.succeed([edge, [...current, edge]] as const);
      }),
      () => effect,
      (edge) =>
        SynchronizedRef.update(edges, (current) => current.filter((entry) => entry.id !== edge.id)),
    );

  const send: BotMessaging["Service"]["send"] = Effect.fn("BotMessaging.send")(function* (input) {
    const bots = (yield* projects
      .listShells()
      .pipe(Effect.mapError(() => fail("Could not list the bots.")))).filter(
      (shell) => shell.bot != null,
    );
    const sender = bots.find((bot) => bot.id === input.sender.projectId);
    if (sender === undefined) return yield* fail("bot_message works only in a bot's conversation.");
    const target = yield* resolveTarget(sender, input.to, bots);
    const text = input.wait
      ? `Message from ${sender.title} (bot). Reply here; your final reply is returned to ${sender.title}.\n\n${input.message}`
      : `Message from ${sender.title} (bot). ${sender.title} is not waiting for a reply; to tell them something later, use bot_message.\n\n${input.message}`;
    const pair = `${sender.id}\u0000${target.id}`;
    if (!input.wait) {
      const delivered = yield* pairLocks.withLock(pair, deliver(input, sender, target, text));
      return {
        to: target.title,
        projectId: target.id,
        threadId: delivered.threadId,
        status: "delivered",
        reply: null,
        note: `Delivered to ${target.title} in thread ${delivered.threadId}.`,
      } satisfies BotMessageResult;
    }
    return yield* whileWaiting(
      sender,
      target,
      pairLocks
        .withLock(pair, deliver(input, sender, target, text))
        .pipe(
          Effect.flatMap((delivered) => awaitReply(target, delivered.threadId, delivered.runId)),
        ),
    );
  });

  return BotMessaging.of({ send });
});

export const layer = Layer.effect(BotMessaging, make);
