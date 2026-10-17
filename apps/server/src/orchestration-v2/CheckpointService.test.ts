import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
} from "@mybot/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@mybot/provider-core/server/IdAllocator";

const layerTest = CheckpointService.layer.pipe(
  Layer.provide(IdAllocator.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

it.effect("materializes a ready baseline and chains captures to the previous ordinal", () => {
  const scope: OrchestrationV2CheckpointScope = {
    id: CheckpointScopeId.make("checkpoint-scope:materialize-baseline"),
    threadId: ThreadId.make("thread:materialize-baseline"),
    runId: RunId.make("run:materialize-baseline:3"),
    nodeId: NodeId.make("node:materialize-baseline:3"),
    parentScopeId: null,
    providerThreadId: ProviderThreadId.make("provider-thread:materialize-baseline"),
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: "/repo",
    createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
  };

  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const baseline = yield* checkpoints.materializeBaselineCheckpoint({
      scope,
      ordinalWithinScope: 2,
    });

    assert.equal(baseline.ordinalWithinScope, 2);
    assert.equal(baseline.scopeId, scope.id);
    assert.isNull(baseline.runId);
    assert.isNull(baseline.appRunOrdinal);
    assert.equal(
      baseline.ref,
      yield* CheckpointService.checkpointRefForScopeOrdinal({
        scopeId: scope.id,
        ordinalWithinScope: 2,
      }),
    );
    assert.equal(baseline.status, "ready");
    assert.deepEqual(baseline.files, []);

    const captured = yield* checkpoints.capture({
      scope,
      ordinalWithinScope: 3,
      runId: scope.runId,
      nodeId: scope.nodeId!,
      appRunOrdinal: 3,
      capturedAt: scope.createdAt,
    });
    assert.equal(captured.parentCheckpointId, baseline.id);
    assert.equal(captured.runId, scope.runId);
    assert.equal(captured.appRunOrdinal, 3);
    assert.equal(captured.status, "ready");
    assert.deepEqual(captured.files, []);
    assert.equal(
      captured.ref,
      yield* CheckpointService.checkpointRefForScopeOrdinal({
        scopeId: scope.id,
        ordinalWithinScope: 3,
      }),
    );
  }).pipe(Effect.provide(layerTest));
});
