import { EnvironmentId, WS_METHODS } from "@mybot/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  observeBackgroundActivitySubscription,
  retainedBackgroundScopes,
  wasRecentlyInteracted,
} from "./backgroundActivityReporter.ts";

describe("wasRecentlyInteracted", () => {
  it("expires interaction independently of window focus", () => {
    expect(wasRecentlyInteracted(10_000, 55_000)).toBe(true);
    expect(wasRecentlyInteracted(10_000, 55_001)).toBe(false);
  });

  it("rejects future timestamps", () => {
    expect(wasRecentlyInteracted(10_001, 10_000)).toBe(false);
  });

  it.effect("retains an observed subscription until its returned finalizer runs", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-observation-test");
      const ignored = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeServerConfig,
        input: {},
      });
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
      const release = yield* observeBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeResourceTelemetry,
        input: {},
      });

      expect(retainedBackgroundScopes(environmentId)).toEqual([{ type: "diagnostics" }]);

      yield* ignored;
      yield* release;
      expect(retainedBackgroundScopes(environmentId)).toEqual([]);
    }),
  );
});
