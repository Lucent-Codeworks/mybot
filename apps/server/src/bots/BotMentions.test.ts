import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@mybot/contracts";
import { formatBotMention } from "@mybot/shared/botMentions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotMentions from "./BotMentions.ts";

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

const model = (instanceId: string, name: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model: name,
});
const hostModel = model("codex", "gpt-5.4");
const scoutModel = model("claudeAgent", "claude-opus-4-6");

const shell = (
  id: string,
  defaultModelSelection: ModelSelection | null,
  bot: OrchestrationProjectShell["bot"] = { role: "", instructions: "" },
): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot: `/projects/${id}`,
  defaultModelSelection,
  bot,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});
const host = shell("host", hostModel);
const scout = shell("scout", scoutModel);
const threadId = ThreadId.make("thread-1");

const message = (text: string, overrides: Partial<MessageDispatch> = {}): MessageDispatch => ({
  type: "message.dispatch",
  commandId: CommandId.make("command-1"),
  createdBy: "user",
  creationSource: "web",
  threadId,
  messageId: MessageId.make("message-new"),
  text,
  attachments: [],
  deliveryIntent: "auto",
  dispatchMode: { type: "start_immediately" },
  ...overrides,
});

const run = (
  ordinal: number,
  modelSelection: ModelSelection,
  status: OrchestrationV2Run["status"] = "completed",
) =>
  ({
    id: `run-${ordinal}`,
    ordinal,
    status,
    modelSelection,
    userMessageId: MessageId.make(`message-${ordinal}`),
  }) as unknown as OrchestrationV2Run;

/** A chat in `host` whose earlier messages are `texts`, answered on `models`. */
const layerChat = (
  history: ReadonlyArray<{ text: string; model: ModelSelection }>,
  active = false,
) =>
  Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({ listShells: () => Effect.succeed([host, scout]) }),
    ServerSettings.layerTest(),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: ((_threadId: ThreadId, fields: ReadonlyArray<string>) =>
        Effect.succeed({
          thread: { projectId: host.id, modelSelection: history.at(-1)?.model ?? hostModel },
          ...(fields.includes("runs")
            ? {
                runs: history.map((entry, index) =>
                  run(
                    index + 1,
                    entry.model,
                    active && index === history.length - 1 ? "running" : "completed",
                  ),
                ),
              }
            : {}),
          ...(fields.includes("messages")
            ? {
                messages: history.map((entry, index) => ({
                  id: MessageId.make(`message-${index + 1}`),
                  text: entry.text,
                })),
              }
            : {}),
        })) as never,
    }),
  );

const mention = formatBotMention(scout);

it.effect("a mention runs on the mentioned bot's model", () =>
  Effect.gen(function* () {
    const routed = yield* BotMentions.routeMessage(message(`${mention} find flights`));
    assert.deepStrictEqual(routed.modelSelection, scoutModel);
  }).pipe(Effect.provide(layerChat([{ text: "hi", model: hostModel }]))),
);

it.effect("a mention waits for the running turn instead of steering it", () =>
  Effect.gen(function* () {
    const routed = yield* BotMentions.routeMessage(message(`${mention} find flights`));
    assert.deepStrictEqual(routed.dispatchMode, { type: "queue_after_active" });
    assert.isUndefined(routed.deliveryIntent);
  }).pipe(Effect.provide(layerChat([{ text: "hi", model: hostModel }], true))),
);

it.effect("the next message goes back to the chat's own model", () =>
  Effect.gen(function* () {
    const routed = yield* BotMentions.routeMessage(
      message("thanks", { modelSelection: scoutModel }),
    );
    assert.deepStrictEqual(routed.modelSelection, hostModel);
  }).pipe(
    Effect.provide(
      layerChat([
        { text: "hi", model: hostModel },
        { text: `${mention} find flights`, model: scoutModel },
      ]),
    ),
  ),
);

it.effect("a model the user picked after a mention is kept", () =>
  Effect.gen(function* () {
    const picked = model("codex", "gpt-5.5");
    const routed = yield* BotMentions.routeMessage(message("thanks", { modelSelection: picked }));
    assert.deepStrictEqual(routed.modelSelection, picked);
  }).pipe(
    Effect.provide(
      layerChat([
        { text: "hi", model: hostModel },
        { text: `${mention} find flights`, model: scoutModel },
      ]),
    ),
  ),
);

it("a chat that started with a mention goes back to its bot's default model", () => {
  assert.deepStrictEqual(
    BotMentions.restoredModelSelection({
      requested: scoutModel,
      runs: [{ modelSelection: scoutModel, mentioned: true }],
      hostDefault: hostModel,
    }),
    hostModel,
  );
});
