import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveCodexRollbackTurnCount } from "./Adapters/CodexAdapterV2.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const layerCheckpointRollbackService = CheckpointRollbackService.layer;

it.effect("rejects a non-ready checkpoint before opening a session", () => {
  const threadId = ThreadId.make("thread:rollback-non-ready");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-non-ready");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-non-ready");
  const checkpointId = CheckpointId.make("checkpoint:rollback-non-ready");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-non-ready");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_non_ready");
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
    checkpoints: [{ id: checkpointId, scopeId, status: "stale" }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
  } as unknown as OrchestrationV2ThreadProjection;
  const layerTest = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "rollback-target-invalid");
    assert.equal(
      error.message,
      `Rollback target ${checkpointId} for provider thread ${providerThreadId} on thread ${threadId} is incomplete or invalid.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
  }).pipe(Effect.provide(layerTest));
});

it.effect("rejects a rollback when another provider thread became active", () => {
  const threadId = ThreadId.make("thread:rollback-inactive-provider-thread");
  const requestedProviderThreadId = ProviderThreadId.make(
    "provider-thread:rollback-inactive-provider-thread:requested",
  );
  const activeProviderThreadId = ProviderThreadId.make(
    "provider-thread:rollback-inactive-provider-thread:active",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-inactive-provider-thread",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-inactive-provider-thread");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-inactive-provider-thread");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_inactive_provider_thread");
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      activeProviderThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [
      {
        id: requestedProviderThreadId,
        providerSessionId,
        providerInstanceId,
      },
    ],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready" }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
  } as unknown as OrchestrationV2ThreadProjection;
  const layerTest = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId: requestedProviderThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "active-provider-changed");
    assert.equal(
      error.message,
      `Active provider changed before rollback target ${checkpointId} could execute on thread ${threadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
  }).pipe(Effect.provide(layerTest));
});

it.effect("rejects a rollback when provider selection changed before execution", () => {
  const threadId = ThreadId.make("thread:rollback-provider-selection-changed");
  const providerThreadId = ProviderThreadId.make(
    "provider-thread:rollback-provider-selection-changed",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-provider-selection-changed",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-provider-selection-changed");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-provider-selection-changed");
  const originalProviderInstanceId = ProviderInstanceId.make(
    "provider_rollback_provider_selection_changed_original",
  );
  const selectedProviderInstanceId = ProviderInstanceId.make(
    "provider_rollback_provider_selection_changed_selected",
  );
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: selectedProviderInstanceId, model: "test-model" },
    },
    providerThreads: [
      {
        id: providerThreadId,
        providerSessionId,
        providerInstanceId: originalProviderInstanceId,
      },
    ],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready" }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
  } as unknown as OrchestrationV2ThreadProjection;
  const layerTest = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "active-provider-changed");
    assert.equal(
      error.message,
      `Active provider changed before rollback target ${checkpointId} could execute on thread ${threadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
  }).pipe(Effect.provide(layerTest));
});

it.effect("reports a missing provider turn as a structured rollback failure", () => {
  const threadId = ThreadId.make("thread:rollback-provider-turn-unavailable");
  const providerThreadId = ProviderThreadId.make(
    "provider-thread:rollback-provider-turn-unavailable",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-provider-turn-unavailable",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-provider-turn-unavailable");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-provider-turn-unavailable");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_provider_turn_unavailable");
  const projection = {
    thread: {
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
    providerSessions: [],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready", appRunOrdinal: 1 }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
    runs: [],
    attempts: [],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layerTest = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.mock(EventSink.EventSinkV2)({}),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () => Effect.succeed({} as never),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "provider-turn-unavailable");
    assert.equal(
      error.message,
      `Provider turn for rollback target ${checkpointId} is unavailable on provider thread ${providerThreadId}.`,
    );
    assert.equal(error.cause, undefined);
  }).pipe(Effect.provide(layerTest));
});

it.effect.each([0, 1])("rolls back the provider conversation to app run %s", (targetOrdinal) => {
  const threadId = ThreadId.make("rewind-conversation");
  const providerThreadId = ProviderThreadId.make("rewind-provider");
  const providerSessionId = ProviderSessionId.make("rewind-session");
  const instanceId = ProviderInstanceId.make("rewind-instance");
  const checkpointId = CheckpointId.make("rewind-target");
  const scopeId = CheckpointScopeId.make("rewind-scope");
  const calls: string[] = [];
  const written: Array<OrchestrationV2DomainEvent> = [];
  let lockedThreads = Effect.succeed<ReadonlyArray<ThreadId>>([]);
  const layerThreadCommands = Layer.effect(
    ThreadCommandExecutor.ThreadCommandExecutor,
    Effect.tap(KeyedLock.make<ThreadId>(), (lock) =>
      Effect.sync(() => {
        lockedThreads = lock.activeKeys;
      }),
    ),
  );
  const providerThread = {
    id: providerThreadId,
    providerSessionId,
    providerInstanceId: instanceId,
  };
  const projection = {
    thread: {
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId, model: "test" },
    },
    providerThreads: [providerThread],
    providerSessions: [],
    // Turn 3 remains in the audit history after an earlier rollback.
    providerTurns: [1, 2, 3].map((ordinal) => ({
      id: `turn-${ordinal}`,
      providerThreadId,
      runAttemptId: `attempt-${ordinal}`,
      ordinal,
      status: "completed",
    })),
    nodes: [],
    attempts: [1, 2, 3].map((ordinal) => ({ id: `attempt-${ordinal}`, runId: `run-${ordinal}` })),
    checkpoints: [
      { id: checkpointId, scopeId, status: "ready", appRunOrdinal: targetOrdinal || null },
      ...[1, 2]
        .filter((ordinal) => ordinal > targetOrdinal)
        .map((ordinal) => ({
          id: `later-checkpoint-${ordinal}`,
          scopeId,
          runId: `run-${ordinal}`,
          nodeId: `node-${ordinal}`,
          status: "ready",
          appRunOrdinal: ordinal,
        })),
    ],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
    runs: [1, 2, 3].map((ordinal) => ({
      id: `run-${ordinal}`,
      ordinal,
      status: ordinal === 3 ? "rolled_back" : "completed",
      rootNodeId: null,
      activeAttemptId: `attempt-${ordinal}`,
    })),
  } as unknown as OrchestrationV2ThreadProjection;
  const layerTest = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadCommands,
        Layer.mock(EventSink.EventSinkV2)({
          write: ({ events }) =>
            Effect.map(lockedThreads, (locked) => {
              // A thread command that planned against the old provider thread
              // must not commit after this and undo the rollback.
              assert.include(locked, threadId);
              written.push(...events);
              calls.push("projection");
              return [];
            }),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              rollbackThread: (input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
                Effect.gen(function* () {
                  const count = yield* resolveCodexRollbackTurnCount(input);
                  assert.equal(count, 2 - targetOrdinal);
                  calls.push("provider");
                  return { providerThread };
                }),
            } as never),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
    yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId });
    assert.deepEqual(calls, ["provider", "projection"]);

    const laterOrdinals = [1, 2].filter((ordinal) => ordinal > targetOrdinal);
    assert.deepEqual(
      written.flatMap((event) =>
        event.type === "checkpoint.captured" ? [[event.payload.id, event.payload.status]] : [],
      ),
      laterOrdinals.map((ordinal) => [`later-checkpoint-${ordinal}`, "stale"]),
    );
    assert.deepEqual(
      written.flatMap((event) =>
        event.type === "run.updated" ? [[event.payload.id, event.payload.status]] : [],
      ),
      laterOrdinals.map((ordinal) => [`run-${ordinal}`, "rolled_back"]),
    );
    const providerThreadUpdate = written.find((event) => event.type === "provider-thread.updated");
    assert.equal(
      providerThreadUpdate?.type === "provider-thread.updated"
        ? providerThreadUpdate.payload.lastRunOrdinal
        : undefined,
      targetOrdinal === 0 ? null : targetOrdinal,
    );
  }).pipe(Effect.provide(layerTest));
});
