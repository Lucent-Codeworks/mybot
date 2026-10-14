import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  onRetainedMobileBackgroundScopesChange,
  observeMobileBackgroundActivitySubscription,
  retainedMobileBackgroundScopes,
} from "./background-activity-scopes";

describe("mobile background activity", () => {
  it.effect("retains diagnostics demand only while the mobile subscription is active", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("mobile-environment");
      const releaseFirst = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeResourceTelemetry,
        input: {},
      });
      const releaseSecond = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeResourceTelemetry,
        input: {},
      });

      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([{ type: "diagnostics" }]);

      yield* releaseFirst;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([{ type: "diagnostics" }]);

      yield* releaseSecond;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
    }),
  );

  it.effect("keeps delimiter-containing environment values distinct", () =>
    Effect.gen(function* () {
      const firstEnvironmentId = EnvironmentId.make("a");
      const secondEnvironmentId = EnvironmentId.make("a:diagnostics:b");
      const releaseFirst = yield* observeMobileBackgroundActivitySubscription({
        environmentId: firstEnvironmentId,
        method: WS_METHODS.subscribeResourceTelemetry,
        input: {},
      });

      expect(retainedMobileBackgroundScopes(firstEnvironmentId)).toEqual([{ type: "diagnostics" }]);
      expect(retainedMobileBackgroundScopes(secondEnvironmentId)).toEqual([]);

      yield* releaseFirst;
    }),
  );

  it.effect("returns a release handle when a retained-scope listener throws", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("throwing-listener-environment");
      const removeListener = onRetainedMobileBackgroundScopesChange(() => {
        throw new Error("listener failed");
      });

      const release = yield* observeMobileBackgroundActivitySubscription({
        environmentId,
        method: WS_METHODS.subscribeResourceTelemetry,
        input: {},
      });
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([{ type: "diagnostics" }]);

      yield* release;
      expect(retainedMobileBackgroundScopes(environmentId)).toEqual([]);
      removeListener();
    }),
  );
});
