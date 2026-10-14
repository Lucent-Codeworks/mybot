import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE, PrimaryConnectionTarget } from "../connection/model.ts";
import {
  createEnvironmentPresentationAtoms,
  createEnvironmentSummaryAtoms,
} from "./presentation.ts";
import type { EnvironmentCatalogState } from "./connections.ts";

const FIRST = EnvironmentId.make("first");
const SECOND = EnvironmentId.make("second");
function entry(environmentId: EnvironmentId, label = environmentId as string) {
  return {
    target: new PrimaryConnectionTarget({
      environmentId,
      label,
      httpBaseUrl: "https://example.test",
      wsBaseUrl: "wss://example.test",
    }),
    enabled: true,
    profile: Option.none(),
  };
}
function config(cwd = "/workspace"): ServerConfig {
  return {
    cwd,
    environment: { capabilities: {}, platform: { machine: "desktop" } },
  } as ServerConfig;
}
function harness() {
  const catalog = Atom.make<EnvironmentCatalogState>({
    isReady: true,
    entries: new Map([
      [FIRST, entry(FIRST)],
      [SECOND, entry(SECOND)],
    ]),
  });
  const configs = Atom.family((_id: EnvironmentId) => Atom.make<ServerConfig | null>(config()));
  const state = Atom.make(AsyncResult.success(AVAILABLE_CONNECTION_STATE));
  const full = createEnvironmentPresentationAtoms({
    catalogValueAtom: catalog,
    stateAtom: () => state,
    serverConfigValueAtom: configs,
  });
  const summaries = createEnvironmentSummaryAtoms({
    catalogValueAtom: catalog,
    presentationAtom: full.presentationAtom,
  });
  return { catalog, configs, state, full, ...summaries, registry: AtomRegistry.make() };
}

describe("environment summary subscriptions", () => {
  it("keeps connected search targets stable through config refreshes and updates them on disconnect", () => {
    const h = harness();
    let changes = 0;
    const stop = h.registry.subscribe(h.connectedEnvironmentIdsAtom, () => changes++);
    try {
      expect(h.registry.get(h.connectedEnvironmentIdsAtom)).toEqual([]);
      h.registry.set(
        h.state,
        AsyncResult.success({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
          generation: 1,
        }),
      );
      const connected = h.registry.get(h.connectedEnvironmentIdsAtom);
      expect(connected).toEqual([FIRST, SECOND]);
      const connectionChanges = changes;
      expect(connectionChanges).toBeGreaterThan(0);
      for (let index = 0; index < 20; index++) {
        h.registry.set(h.configs(FIRST), config(`/workspace-${index}`));
        expect(h.registry.get(h.connectedEnvironmentIdsAtom)).toBe(connected);
      }
      expect(changes).toBe(connectionChanges);
      h.registry.set(h.state, AsyncResult.success(AVAILABLE_CONNECTION_STATE));
      expect(h.registry.get(h.connectedEnvironmentIdsAtom)).toEqual([]);
      expect(changes).toBeGreaterThan(connectionChanges);
    } finally {
      stop();
      h.registry.dispose();
    }
  });

  it("updates machine icons and preserves cached icons for disabled environments", () => {
    const h = harness();
    try {
      expect(h.registry.get(h.machineByIdAtom).get(FIRST)).toBe("desktop");
      h.registry.set(h.configs(FIRST), {
        ...config(),
        settings: { environmentIcon: "laptop" },
      } as ServerConfig);
      expect(h.registry.get(h.machineByIdAtom).get(FIRST)).toBe("laptop");
      h.registry.set(h.catalog, {
        isReady: true,
        entries: new Map([[FIRST, { ...entry(FIRST), enabled: false }]]),
      });
      expect(h.registry.get(h.machineByIdAtom)).toEqual(new Map([[FIRST, "laptop"]]));
      h.registry.set(h.configs(FIRST), null);
      expect(h.registry.get(h.machineByIdAtom).get(FIRST)).toBe("server");
    } finally {
      h.registry.dispose();
    }
  });

  it("tracks environments across catalog changes and removal", () => {
    const h = harness();
    const stop = h.registry.subscribe(h.environmentIdsAtom, () => {});
    try {
      h.registry.set(h.catalog, { isReady: true, entries: new Map([[FIRST, entry(FIRST)]]) });
      expect(h.registry.get(h.environmentIdsAtom)).toEqual([FIRST]);
      expect(h.registry.get(h.identitiesAtom)).toEqual([{ environmentId: FIRST, label: "first" }]);
      h.registry.set(h.catalog, {
        isReady: true,
        entries: new Map([
          [SECOND, entry(SECOND)],
          [FIRST, entry(FIRST)],
        ]),
      });
      expect(h.registry.get(h.environmentIdsAtom)).toEqual([SECOND, FIRST]);
      h.registry.set(h.catalog, { isReady: true, entries: new Map() });
      expect(h.registry.get(h.environmentIdsAtom)).toEqual([]);
      expect(h.registry.get(h.identitiesAtom)).toEqual([]);
      expect(h.registry.get(h.environmentsAtom)).toEqual([]);
    } finally {
      stop();
      h.registry.dispose();
    }
  });
});
