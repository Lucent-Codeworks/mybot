import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TelegramChannel from "./TelegramChannel.ts";

const projectId = ProjectId.make("project-scout");
const OWNER = 42;

interface FakeTelegram {
  /** Each offer is the next getUpdates response; getUpdates blocks until one arrives. */
  readonly updates: Queue.Queue<ReadonlyArray<unknown>>;
  /** Text of every sendMessage, in order. */
  readonly sent: Queue.Queue<string>;
}

const message = (fromUserId: number, text: string, updateId: number) => [
  {
    update_id: updateId,
    message: { chat: { id: fromUserId, type: "private" }, from: { id: fromUserId }, text },
  },
];

const layerFakeTelegram = (fake: FakeTelegram) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const method = request.url.split("/").at(-1);
        const body =
          request.body._tag === "Uint8Array"
            ? (JSON.parse(new TextDecoder().decode(request.body.body)) as { text?: string })
            : {};
        const result =
          method === "getMe"
            ? { id: 1, username: "scout_bot" }
            : method === "getUpdates"
              ? yield* Queue.take(fake.updates)
              : method === "sendMessage"
                ? yield* Queue.offer(fake.sent, body.text ?? "").pipe(Effect.as(true))
                : true;
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ ok: true, result }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

const layerMemorySecrets = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const values = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  });
});

interface FakeThreads {
  readonly launched: Array<string>;
  readonly delivered: Array<{ readonly threadId: string; readonly text: string }>;
}

const layerFakeThreads = (threads: FakeThreads) =>
  Layer.mergeAll(
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          threads.launched.push(input.title);
          return {
            threadId: ThreadId.make(`thread-${threads.launched.length}`),
          } as ThreadLaunchService.ThreadLaunchResult;
        }),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      sendToThread: (input) =>
        Effect.sync(() => {
          threads.delivered.push({ threadId: input.threadId, text: input.text });
          return {
            run: { id: RunId.make(`run-${threads.delivered.length}`) },
          } as ThreadManagementService.ThreadManagementSendResult;
        }),
      waitForThread: (input) =>
        Effect.succeed({
          threadId: input.threadId,
          run: { status: "completed" },
          timedOut: false,
        } as ThreadManagementService.ThreadManagementWaitResult),
      waitForPendingRequest: () => Effect.never,
      getThreadRecords: () =>
        Effect.succeed({
          messages: [
            {
              text: `Reply to ${threads.delivered.at(-1)?.text}`,
              streaming: false,
              createdAt: DateTime.makeUnsafe("2026-10-14T00:00:00.000Z"),
            },
          ],
        } as never),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeed(Option.some({ id: projectId } as never)),
    }),
    ServerSettings.layerTest({
      projectSettingsOverrides: {
        [projectId]: {
          defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        },
      },
    }),
  );

it.effect("pairs the owner, refuses strangers, and relays conversations", () =>
  Effect.gen(function* () {
    const fake: FakeTelegram = {
      updates: yield* Queue.unbounded<ReadonlyArray<unknown>>(),
      sent: yield* Queue.unbounded<string>(),
    };
    const threads: FakeThreads = { launched: [], delivered: [] };
    yield* Effect.gen(function* () {
      const telegram = yield* TelegramChannel.TelegramChannel;
      const connected = yield* telegram.connect(projectId, "123:token");
      assert.deepInclude(connected, { connected: true, username: "scout_bot", paired: false });
      const code = connected.pairingCode ?? "";
      assert.match(code, /^[0-9A-F]{8}$/);

      yield* Queue.offer(fake.updates, message(7, "hello", 1));
      assert.include(yield* Queue.take(fake.sent), "private");

      yield* Queue.offer(fake.updates, message(OWNER, `/start ${code}`, 2));
      assert.include(yield* Queue.take(fake.sent), "Paired");
      assert.isTrue((yield* telegram.status(projectId)).paired);

      // Once paired, the code no longer lets anyone else in.
      yield* Queue.offer(fake.updates, message(7, `/start ${code}`, 3));
      assert.include(yield* Queue.take(fake.sent), "private");

      yield* Queue.offer(fake.updates, message(OWNER, "Plan my day", 4));
      assert.equal(yield* Queue.take(fake.sent), "Reply to Plan my day");
      yield* Queue.offer(fake.updates, message(OWNER, "And tomorrow?", 5));
      assert.equal(yield* Queue.take(fake.sent), "Reply to And tomorrow?");
      assert.deepEqual(threads.launched, ["Telegram"]);
      assert.deepEqual(
        threads.delivered.map((delivery) => delivery.threadId),
        ["thread-1", "thread-1"],
      );

      yield* Queue.offer(fake.updates, message(OWNER, "/new", 6));
      assert.include(yield* Queue.take(fake.sent), "new conversation");
      yield* Queue.offer(fake.updates, message(OWNER, "Fresh start", 7));
      assert.equal(yield* Queue.take(fake.sent), "Reply to Fresh start");
      assert.equal(threads.delivered.at(-1)?.threadId, "thread-2");

      const disconnected = yield* telegram.disconnect(projectId);
      assert.isFalse(disconnected.connected);
    }).pipe(
      Effect.provide(
        TelegramChannel.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              layerFakeTelegram(fake),
              layerMemorySecrets,
              layerFakeThreads(threads),
              NodeServices.layer,
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("forwards an approval to the chat and sends the owner's answer back", () =>
  Effect.gen(function* () {
    const fake: FakeTelegram = {
      updates: yield* Queue.unbounded<ReadonlyArray<unknown>>(),
      sent: yield* Queue.unbounded<string>(),
    };
    const requestId = RuntimeRequestId.make("request-1");
    const answered = yield* Deferred.make<unknown>();
    const layerThreads = Layer.mergeAll(
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: () =>
          Effect.succeed({
            threadId: ThreadId.make("thread-1"),
          } as ThreadLaunchService.ThreadLaunchResult),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        sendToThread: () =>
          Effect.succeed({
            run: { id: RunId.make("run-1") },
          } as ThreadManagementService.ThreadManagementSendResult),
        // The run stops on one approval and ends once it is answered.
        waitForPendingRequest: (input) =>
          input.ignore.has(requestId)
            ? Effect.never
            : Effect.succeed(Option.some({ id: requestId, status: "pending" } as never)),
        waitForThread: (input) =>
          Deferred.await(answered).pipe(
            Effect.as({
              threadId: input.threadId,
              run: { status: "completed" },
              timedOut: false,
            } as ThreadManagementService.ThreadManagementWaitResult),
          ),
        dispatch: (command) =>
          Deferred.succeed(answered, command).pipe(Effect.as({ sequence: 1 } as never)),
        getThreadRecords: (_threadId, fields) =>
          Effect.succeed(
            (fields as ReadonlyArray<string>).includes("turnItems")
              ? {
                  turnItems: [
                    {
                      type: "approval_request",
                      requestId,
                      title: "Send email to Dana",
                      prompt: "Subject: Friday",
                    },
                  ],
                }
              : {
                  messages: [
                    {
                      text: "Sent.",
                      streaming: false,
                      createdAt: DateTime.makeUnsafe("2026-10-14T00:00:00.000Z"),
                    },
                  ],
                },
          ) as never,
      }),
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeed(Option.some({ id: projectId } as never)),
      }),
      ServerSettings.layerTest({
        projectSettingsOverrides: {
          [projectId]: {
            defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          },
        },
      }),
    );
    yield* Effect.gen(function* () {
      const telegram = yield* TelegramChannel.TelegramChannel;
      const code = (yield* telegram.connect(projectId, "123:token")).pairingCode ?? "";
      yield* Queue.offer(fake.updates, message(OWNER, `/start ${code}`, 1));
      yield* Queue.take(fake.sent);

      yield* Queue.offer(fake.updates, message(OWNER, "Email Dana about Friday", 2));
      const prompt = yield* Queue.take(fake.sent);
      assert.include(prompt, "needs your approval");
      assert.include(prompt, "Send email to Dana");

      yield* Queue.offer(fake.updates, message(OWNER, "maybe", 3));
      assert.include(yield* Queue.take(fake.sent), "Reply yes, always, or no");

      yield* Queue.offer(fake.updates, message(OWNER, "yes", 4));
      assert.equal(yield* Queue.take(fake.sent), "Got it.");
      assert.deepInclude(yield* Deferred.await(answered), {
        type: "runtime-request.respond",
        requestId,
        decision: "accept",
      });
      assert.equal(yield* Queue.take(fake.sent), "Sent.");
    }).pipe(
      Effect.provide(
        TelegramChannel.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              layerFakeTelegram(fake),
              layerMemorySecrets,
              layerThreads,
              NodeServices.layer,
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);
