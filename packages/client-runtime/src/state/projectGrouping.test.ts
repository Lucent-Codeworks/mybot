import { EnvironmentId, ProjectId } from "@mybot/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import { chooseLoadBalancedEnvironment } from "../load-balancing.ts";
import {
  buildProjectGroups,
  derivePhysicalProjectKey,
  resolveScratchProjectScopeKey,
} from "./projectGrouping.ts";

const environmentId = EnvironmentId.make("environment");

describe("load balancing shared project machines", () => {
  const now = 100_000;
  const resources = {
    sampledAt: now,
    cpuUtilization: 0.2,
    cpuCount: 8,
    availableMemoryBytes: 8_000,
    totalMemoryBytes: 16_000,
  };

  it("compares three machines using free capacity and preference", () => {
    const candidates = [
      { environmentId: "busy", resources: { ...resources, cpuUtilization: 0.9 }, weight: 1 },
      { environmentId: "idle", resources, weight: 1 },
      { environmentId: "preferred", resources: { ...resources, cpuCount: 4 }, weight: 3 },
    ];
    expect(chooseLoadBalancedEnvironment(candidates, now)).toBe("preferred");
    expect(chooseLoadBalancedEnvironment(candidates.slice(0, 2), now)).toBe("idle");
  });

  it("rejects stale, unknown, excluded and saturated machines", () => {
    expect(
      chooseLoadBalancedEnvironment(
        [
          {
            environmentId: "stale",
            resources: { ...resources, sampledAt: now - 15_001 },
            weight: 1,
          },
          { environmentId: "unknown", resources: null, weight: 1 },
          {
            environmentId: "no-cpu-sample",
            resources: { ...resources, cpuUtilization: null },
            weight: 1,
          },
          { environmentId: "excluded", resources, weight: 0 },
          {
            environmentId: "cpu-full",
            resources: { ...resources, cpuUtilization: 0.95 },
            weight: 1,
          },
          {
            environmentId: "memory-full",
            resources: { ...resources, availableMemoryBytes: 100 },
            weight: 1,
          },
        ],
        now,
      ),
    ).toBeNull();
  });

  it("uses client receipt time when host clocks differ", () => {
    const candidate = {
      environmentId: "different-clock",
      resources: { ...resources, sampledAt: now + 60_000 },
      receivedAt: now,
      weight: 1,
    };
    expect(chooseLoadBalancedEnvironment([candidate], now)).toBe("different-clock");
    expect(chooseLoadBalancedEnvironment([candidate], now + 15_001)).toBeNull();
  });
});

function makeProject(
  id: string,
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildProjectGroups", () => {
  it("groups one project per folder", () => {
    const groups = buildProjectGroups({
      projects: [makeProject("app", "/work/app"), makeProject("api", "/work/api")],
    });
    expect(groups.map((group) => group.label)).toEqual(["app", "api"]);
  });

  it("dedupes stale registrations at one physical path using the freshest project", () => {
    const stale = makeProject("stale", "/work/mybot", {
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const fresh = makeProject("fresh", "/work/mybot/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });

    const groups = buildProjectGroups({ projects: [stale, fresh] });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(1);
    expect(groups[0]?.representative.id).toBe("fresh");
    expect(groups[0]?.memberProjectRefs).toHaveLength(2);
  });

  it("keeps scratch projects apart by default and groups them when asked", () => {
    const projects = [
      makeProject("scratch-a", "/scratch/a", { isScratch: true }),
      makeProject("scratch-b", "/scratch/b", { isScratch: true }),
    ];
    expect(buildProjectGroups({ projects })).toHaveLength(2);
    const grouped = buildProjectGroups({ projects, groupScratchProjects: true });
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.label).toBe("No project");
    expect(grouped[0]?.memberProjectRefs).toHaveLength(2);
  });

  it("resolves a scratch project's folder key to the shared scratch scope", () => {
    const scratch = makeProject("scratch", "/scratch/a", { isScratch: true });
    const project = makeProject("app", "/work/app");
    const scratchScope = buildProjectGroups({
      projects: [scratch],
      groupScratchProjects: true,
    })[0]?.key;
    expect(resolveScratchProjectScopeKey(derivePhysicalProjectKey(scratch), [scratch])).toBe(
      scratchScope,
    );
    expect(resolveScratchProjectScopeKey(derivePhysicalProjectKey(project), [project])).toBe(
      derivePhysicalProjectKey(project),
    );
  });
});
