/**
 * BotMentions - `@Name` in a chat makes that bot answer the message, in the
 * same chat, without the chat's own bot deciding who answers.
 *
 * The composer writes a mention as a `bot` reference link that carries the
 * bot's project id. The turn runs on the mentioned bot's model (picked here,
 * where client messages arrive) and with its profile (picked by
 * `RunExecutionService` from the same message). The model of a mention turn
 * sticks to the chat like any model change, so the next message without a
 * mention goes back to the model the chat's own bot last answered on.
 *
 * @module BotMentions
 */
import type {
  ModelSelection,
  OrchestrationProjectShell,
  OrchestrationV2Command,
  OrchestrationV2Run,
  ProjectId,
  ThreadId,
} from "@mybot/contracts";
import { answeringBot } from "@mybot/shared/botMentions";
import { modelSelectionsEqual } from "@mybot/shared/model";
import { resolveProjectSettings } from "@mybot/shared/projectSettings";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

const ACTIVE_RUN_STATUSES: ReadonlyArray<OrchestrationV2Run["status"]> = [
  "preparing",
  "starting",
  "running",
  "waiting",
];

type RunSummary = Pick<OrchestrationV2Run, "modelSelection"> & {
  /** Whether a mentioned bot answered this run instead of the chat's own bot. */
  readonly mentioned: boolean;
};

/**
 * The model a message without a mention goes back to, or undefined to keep the
 * requested one: right after a mention turn, while the chat is still on that
 * turn's model, it is the model the chat's own bot last ran on, or its default.
 */
export const restoredModelSelection = (input: {
  readonly requested: ModelSelection;
  /** The chat's recent runs, oldest first. */
  readonly runs: ReadonlyArray<RunSummary>;
  readonly hostDefault: ModelSelection | null | undefined;
}): ModelSelection | undefined => {
  const latest = input.runs.at(-1);
  if (latest?.mentioned !== true) return undefined;
  if (!modelSelectionsEqual(input.requested, latest.modelSelection)) return undefined;
  const ownModel = input.runs.findLast((run) => !run.mentioned)?.modelSelection;
  return ownModel ?? input.hostDefault ?? undefined;
};

/**
 * A mention never joins the running turn, which belongs to another bot: it
 * waits for that turn, or starts now when nothing runs.
 */
export const mentionDelivery = (
  command: MessageDispatch,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>,
): MessageDispatch => {
  const steers =
    command.deliveryIntent !== undefined ||
    command.dispatchMode.type === "steer_active" ||
    command.dispatchMode.type === "restart_active";
  if (!steers) return command;
  const { deliveryIntent: _intent, ...rest } = command;
  const active = runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status));
  return {
    ...rest,
    dispatchMode: active ? { type: "queue_after_active" } : { type: "start_immediately" },
  };
};

/** Whether the message would steer the active run rather than start one. */
const steersActiveRun = (
  command: Pick<MessageDispatch, "dispatchMode" | "deliveryIntent">,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>,
) =>
  command.dispatchMode.type === "steer_active" ||
  command.dispatchMode.type === "restart_active" ||
  (command.deliveryIntent !== undefined &&
    runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status)));

const listBots = Effect.fn("BotMentions.listBots")(function* () {
  const projects = yield* ProjectService.ProjectService;
  return (yield* projects.listShells()).filter((shell) => shell.bot != null);
});

const defaultModelOf = Effect.fn("BotMentions.defaultModelOf")(function* (
  bot: OrchestrationProjectShell,
) {
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
  return resolveProjectSettings(settings, bot.id, bot).settings.defaultModelSelection;
});

const routeDispatch = Effect.fn("BotMentions.routeDispatch")(function* (command: MessageDispatch) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const records = yield* threads.getThreadRecords(command.threadId, ["runs"]);
  const bots = yield* listBots();
  const host = bots.find((bot) => bot.id === records.thread.projectId);
  if (host === undefined) return command;
  const answering = answeringBot(command.text, bots, host.id);
  if (answering !== undefined) {
    const modelSelection = yield* defaultModelOf(answering);
    const delivered = mentionDelivery(command, records.runs);
    return modelSelection == null ? delivered : { ...delivered, modelSelection };
  }
  if (records.runs.length === 0 || steersActiveRun(command, records.runs)) return command;
  const runs = yield* summarizeRuns(threads, command.threadId, records.runs, bots, host.id);
  if (runs.at(-1)?.mentioned !== true) return command;
  const modelSelection = restoredModelSelection({
    requested: command.modelSelection ?? records.thread.modelSelection,
    runs,
    hostDefault: yield* defaultModelOf(host),
  });
  return modelSelection === undefined ? command : { ...command, modelSelection };
});

/** How many recent runs are checked for the chat's own bot's last model. */
const RECENT_RUNS = 20;

const summarizeRuns = Effect.fn("BotMentions.summarizeRuns")(function* (
  threads: ThreadManagementService.ThreadManagementService["Service"],
  threadId: ThreadId,
  allRuns: ReadonlyArray<OrchestrationV2Run>,
  bots: ReadonlyArray<OrchestrationProjectShell>,
  hostId: ProjectId,
) {
  const runs = allRuns.slice(-RECENT_RUNS);
  const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
    messageIds: runs.map((run) => run.userMessageId),
  });
  const textById = new Map(messages.map((message) => [message.id, message.text]));
  return runs.map((run) => ({
    modelSelection: run.modelSelection,
    mentioned: answeringBot(textById.get(run.userMessageId) ?? "", bots, hostId) !== undefined,
  }));
});

/**
 * Picks the model (and, for a mention, the delivery) of a user's message.
 * Messages the server writes, such as notifications and continuations, pass
 * through unchanged, and so does every message when routing fails.
 */
export const routeMessage = (command: MessageDispatch) => {
  if (
    command.createdBy !== "user" ||
    command.notification !== undefined ||
    command.delegatedCompletion !== undefined ||
    command.restartContinuationOfRunId !== undefined ||
    command.usageLimitContinuationOfRunId !== undefined ||
    command.manualContinuationOfRunId !== undefined
  )
    return Effect.succeed(command);
  return routeDispatch(command).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not route a bot mention.", { cause }).pipe(Effect.as(command)),
    ),
  );
};

/** A new chat whose first message mentions a bot starts on that bot's model. */
export const routeLaunch = (input: ThreadLaunchService.ThreadLaunchInput) => {
  const text = input.initialMessage?.text;
  if (text === undefined) return Effect.succeed(input);
  return Effect.gen(function* () {
    const bots = yield* listBots();
    const answering = answeringBot(text, bots, input.projectId);
    if (answering === undefined) return input;
    const modelSelection = yield* defaultModelOf(answering);
    return modelSelection == null ? input : { ...input, modelSelection };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not route a bot mention.", { cause }).pipe(Effect.as(input)),
    ),
  );
};
