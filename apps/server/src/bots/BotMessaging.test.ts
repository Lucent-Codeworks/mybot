import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationProjectShell,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotMessaging from "./BotMessaging.ts";

const scout = ProjectId.make("project-scout");
const inbox = ProjectId.make("project-inbox");
const mybot = ProjectId.make("project-mybot");
const team = ProjectId.make("project-team");
const inboxModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const callerModel = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus" };

const shell = (
  id: ProjectId,
  title: string,
  bot: OrchestrationProjectShell["bot"],
): OrchestrationProjectShell => ({
  id,
  title,
  workspaceRoot: `/projects/${id}`,
  defaultModelSelection: null,
  bot,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const projects = [
  shell(scout, "Scout", { role: "Research", instructions: "" }),
  shell(inbox, "Inbox", { role: "Inbox triage", instructions: "" }),
  shell(mybot, "MyBot", { role: "Your assistant", instructions: "", orchestrator: true }),
  shell(team, "Team", { role: "Group chat", instructions: "", members: [scout, inbox] }),
  shell(ProjectId.make("project-plain"), "Plain", null),
];

const sender = (projectId: ProjectId): BotMessaging.BotMessageSender => ({
  threadId: ThreadId.make(`thread-of-${projectId}`),
  projectId,
  runtimeMode: "full-access",
  interactionMode: "default",
  modelSelection: callerModel,
});

interface Fake {
  readonly launched: Array<ThreadLaunchService.ThreadLaunchInput>;
  readonly sent: Array<ThreadManagementService.ThreadManagementSendInput>;
  readonly threads: Map<string, OrchestrationV2ThreadShell>;
  /** Ids of deleted threads: no shell, but their projection remains. */
  readonly deleted: Set<string>;
  /** Each run a sender starts waiting on. */
  readonly waiting: Queue.Queue<RunId>;
  /** Holds every run open until completed. */
  gate: Deferred.Deferred<void> | undefined;
  /** A request the receiving bot stops on. */
  request: OrchestrationV2RuntimeRequest | undefined;
}

const makeFake = Effect.gen(function* () {
  const fake: Fake = {
    launched: [],
    sent: [],
    threads: new Map(),
    deleted: new Set(),
    waiting: yield* Queue.unbounded<RunId>(),
    gate: undefined,
    request: undefined,
  };
  const texts = new Map<string, string>();
  const layer = BotMessaging.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.succeed(projects),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              fake.launched.push(input);
              const threadId = input.threadId!;
              fake.threads.set(threadId, {
                id: threadId,
                projectId: input.projectId,
                runtimeMode: input.runtimeMode,
                archivedAt: null,
                deletedAt: null,
              } as OrchestrationV2ThreadShell);
              const runId = RunId.make(`run-${fake.launched.length + fake.sent.length}`);
              texts.set(runId, input.initialMessage!.text);
              return {
                threadId,
                projection: {
                  runs: [{ id: runId, userMessageId: input.initialMessage!.messageId }],
                },
                resumed: false,
              } as unknown as ThreadLaunchService.ThreadLaunchResult;
            }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(fake.threads.get(threadId) ?? null),
          getThreadProjection: (threadId) =>
            fake.deleted.has(threadId)
              ? Effect.succeed({} as never)
              : Effect.fail(
                  new Orchestrator.OrchestratorProjectionError({ threadId, cause: "not found" }),
                ),
          sendToThread: (input) =>
            Effect.sync(() => {
              fake.sent.push(input);
              const runId = RunId.make(`run-${fake.launched.length + fake.sent.length}`);
              texts.set(runId, input.text);
              return { run: { id: runId } } as ThreadManagementService.ThreadManagementSendResult;
            }),
          waitForThread: (input) =>
            Effect.gen(function* () {
              yield* Queue.offer(fake.waiting, input.runId!);
              if (fake.gate !== undefined) yield* Deferred.await(fake.gate);
              return {
                threadId: input.threadId,
                run: { status: "completed" },
                timedOut: false,
              } as ThreadManagementService.ThreadManagementWaitResult;
            }),
          waitForPendingRequest: () =>
            fake.request === undefined ? Effect.never : Effect.succeed(Option.some(fake.request)),
          getThreadRecords: (_threadId, _fields, filter) =>
            Effect.succeed({
              messages: [
                {
                  text: `Done: ${texts
                    .get(filter?.messageRunIds?.[0] ?? "")
                    ?.split("\n\n")
                    .at(-1)}`,
                  streaming: false,
                  createdAt: DateTime.makeUnsafe("2026-10-14T00:00:00.000Z"),
                },
              ],
            } as never),
        }),
        ServerSettings.layerTest({
          projectSettingsOverrides: {
            [inbox]: { defaultModelSelection: inboxModel, defaultRuntimeMode: "approval-required" },
          },
        }),
        NodeCrypto.layer,
      ),
    ),
  );
  return { fake, layer };
});

it.effect("runs as the receiving bot and keeps one conversation per pair", () =>
  Effect.gen(function* () {
    const { fake, layer } = yield* makeFake;
    yield* Effect.gen(function* () {
      const messaging = yield* BotMessaging.BotMessaging;
      const first = yield* messaging.send({
        sender: sender(scout),
        to: "inbox",
        message: "Sort my mail",
        wait: true,
      });
      const conversation = BotMessaging.conversationThreadId(scout, inbox, 1);
      assert.deepInclude(first, {
        to: "Inbox",
        projectId: inbox,
        threadId: conversation,
        status: "replied",
        reply: "Done: Sort my mail",
      });
      const launch = fake.launched[0]!;
      assert.equal(launch.projectId, inbox);
      assert.equal(launch.threadId, conversation);
      assert.equal(launch.title, "Message from Scout");
      assert.deepEqual(launch.modelSelection, inboxModel);
      // The sender runs at full access, but the receiving bot asks before acting.
      assert.equal(launch.runtimeMode, "approval-required");
      assert.equal(launch.initialMessage?.senderThreadId, sender(scout).threadId);
      assert.isTrue(
        launch.initialMessage?.text.startsWith(
          "Message from Scout (bot). Reply here; your final reply is returned to Scout.\n\n",
        ),
      );

      // The second message continues the same conversation, found by its projectId too.
      const second = yield* messaging.send({
        sender: sender(scout),
        to: inbox,
        message: "And the newsletters?",
        wait: true,
      });
      assert.equal(second.reply, "Done: And the newsletters?");
      assert.equal(fake.launched.length, 1);
      assert.equal(fake.sent[0]?.threadId, conversation);
      assert.equal(fake.sent[0]?.mode, "queue");

      // Once the user archives it, the pair starts a fresh conversation.
      fake.threads.set(conversation, {
        ...fake.threads.get(conversation)!,
        archivedAt: DateTime.makeUnsafe("2026-10-14T00:00:00.000Z"),
      });
      const fresh = yield* messaging.send({
        sender: sender(scout),
        to: "Inbox",
        message: "New topic",
        wait: false,
      });
      assert.deepInclude(fresh, {
        status: "delivered",
        threadId: BotMessaging.conversationThreadId(scout, inbox, 2),
      });
      assert.include(
        fake.launched[1]!.initialMessage!.text,
        "Scout is not waiting for a reply; to tell them something later, use bot_message.",
      );

      // A deleted conversation's id is never reused.
      fake.deleted.add(BotMessaging.conversationThreadId(mybot, inbox, 1));
      const afterDelete = yield* messaging.send({
        sender: sender(mybot),
        to: "Inbox",
        message: "Hi",
        wait: false,
      });
      assert.equal(afterDelete.threadId, BotMessaging.conversationThreadId(mybot, inbox, 2));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("refuses unknown bots, itself, and group chats", () =>
  Effect.gen(function* () {
    const { fake, layer } = yield* makeFake;
    yield* Effect.gen(function* () {
      const messaging = yield* BotMessaging.BotMessaging;
      const refusal = (to: string) =>
        messaging.send({ sender: sender(scout), to, message: "Hello", wait: true }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      assert.equal(
        yield* refusal("Nobody"),
        "No bot is named Nobody. You can message: Inbox, MyBot.",
      );
      assert.equal(yield* refusal("SCOUT"), "You can't message yourself.");
      assert.include(
        yield* refusal("Team"),
        "Team is a group chat, which can't receive bot_message.",
      );
      assert.equal(fake.launched.length, 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("refuses a message to a bot that is waiting on the sender, even through others", () =>
  Effect.gen(function* () {
    const { fake, layer } = yield* makeFake;
    const gate = yield* Deferred.make<void>();
    fake.gate = gate;
    yield* Effect.gen(function* () {
      const messaging = yield* BotMessaging.BotMessaging;
      const ask = (from: ProjectId, to: string) =>
        messaging.send({ sender: sender(from), to, message: "Help", wait: true });
      // Scout waits on Inbox, which waits on MyBot.
      const scoutWaits = yield* Effect.forkChild(ask(scout, "Inbox"));
      yield* Queue.take(fake.waiting);
      const inboxWaits = yield* Effect.forkChild(ask(inbox, "MyBot"));
      yield* Queue.take(fake.waiting);

      const back = yield* ask(inbox, "Scout").pipe(Effect.flip);
      assert.equal(
        back.message,
        "Scout is waiting on you; answer in your reply instead of messaging it.",
      );
      const around = yield* ask(mybot, "Scout").pipe(Effect.flip);
      assert.equal(
        around.message,
        "Scout is waiting on you; answer in your reply instead of messaging it.",
      );

      yield* Deferred.succeed(gate, undefined);
      assert.equal((yield* Fiber.join(scoutWaits)).status, "replied");
      assert.equal((yield* Fiber.join(inboxWaits)).status, "replied");
      // With the replies in, nobody waits any more.
      fake.gate = undefined;
      assert.equal((yield* ask(inbox, "Scout")).status, "replied");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("tells the sender when the receiving bot waits on the user", () =>
  Effect.gen(function* () {
    const { fake, layer } = yield* makeFake;
    fake.gate = yield* Deferred.make<void>();
    fake.request = {
      id: RuntimeRequestId.make("request-1"),
      status: "pending",
    } as OrchestrationV2RuntimeRequest;
    yield* Effect.gen(function* () {
      const messaging = yield* BotMessaging.BotMessaging;
      const result = yield* messaging.send({
        sender: sender(scout),
        to: "Inbox",
        message: "Archive the spam",
        wait: true,
      });
      assert.equal(result.status, "waiting_on_user");
      assert.isNull(result.reply);
      assert.include(result.note, `Inbox is waiting on the user`);
      assert.include(result.note, BotMessaging.conversationThreadId(scout, inbox, 1));
    }).pipe(Effect.provide(layer));
  }),
);
