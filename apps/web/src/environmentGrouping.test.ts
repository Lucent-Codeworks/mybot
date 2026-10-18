import { EnvironmentId, ProjectId, ProviderInstanceId } from "@mybot/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveLogicalProjectKey,
  derivePhysicalProjectKey,
  getProjectOrderKey,
} from "./logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
  resolveSidebarProjectScopeKey,
} from "./sidebarProjectGrouping";
import { orderItemsByPreferredIds } from "./components/Sidebar.logic";
import { legacyProjectCwdPreferenceKey } from "./uiStateStore";
import type { Project } from "./types";

const primaryEnvironmentId = EnvironmentId.make("env-primary");
const remoteEnvironmentId = EnvironmentId.make("env-remote");

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-1"),
    environmentId: primaryEnvironmentId,
    title: "shared-repo",
    workspaceRoot: "/tmp/shared-repo",
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

describe("environment grouping", () => {
  it("keeps a saved scope until every environment has loaded", () => {
    const groups = buildSidebarProjectSnapshots({
      projects: [makeProject()],
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });
    const key = groups[0]!.projectKey;
    expect(resolveSidebarProjectScopeKey({ groups, key, canClearMissingScope: true })).toBe(key);
    expect(resolveSidebarProjectScopeKey({ groups: [], key })).toBe(key);
    expect(
      resolveSidebarProjectScopeKey({ groups, key: "removed", canClearMissingScope: true }),
    ).toBeNull();
    expect(resolveSidebarProjectScopeKey({ groups, key: null })).toBeNull();
  });

  it("keeps each project folder in its own group, across environments too", () => {
    const primary = makeProject();
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
    });

    expect(deriveLogicalProjectKey(primary)).toBe(derivePhysicalProjectKey(primary));
    expect(deriveLogicalProjectKey(remote)).toBe(derivePhysicalProjectKey(remote));
    expect(deriveLogicalProjectKey(primary)).not.toBe(deriveLogicalProjectKey(remote));
    expect(
      buildSidebarProjectSnapshots({
        projects: [primary, remote],
        primaryEnvironmentId,
        resolveEnvironmentLabel: () => null,
      }),
    ).toHaveLength(2);
  });

  it("reports whether the project groups span more than one environment", () => {
    const local = makeProject();
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
    });
    const separateLocal = makeProject({
      id: ProjectId.make("workbench-local"),
      title: "workbench",
      workspaceRoot: "/tmp/workbench",
    });
    const build = (projects: Project[]) =>
      buildSidebarProjectSnapshots({
        projects,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) =>
          environmentId === remoteEnvironmentId ? "Mac mini" : "Primary",
      });

    expect(projectGroupsSpanEnvironments(build([remote, local, separateLocal]))).toBe(true);
    expect(projectGroupsSpanEnvironments(build([local, separateLocal]))).toBe(false);
    expect(projectGroupsSpanEnvironments(build([remote]))).toBe(false);
  });

  it("dedupes stale project rows with the same environment and workspace path", () => {
    const duplicate = makeProject({
      id: ProjectId.make("project-duplicate"),
      workspaceRoot: "/tmp/shared-repo/",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const primary = makeProject({
      id: ProjectId.make("project-primary"),
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const snapshots = buildSidebarProjectSnapshots({
      projects: [primary, duplicate],
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => "primary",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.groupedProjectCount).toBe(1);
    expect(snapshots[0]?.memberProjects.map((project) => project.id)).toEqual([primary.id]);
    expect(snapshots[0]?.memberProjectRefs).toEqual([
      { environmentId: primaryEnvironmentId, projectId: primary.id },
      { environmentId: primaryEnvironmentId, projectId: duplicate.id },
    ]);
  });

  it("prefers the fresher project row when duplicate stale rows are ordered first", () => {
    const staleDuplicate = makeProject({
      id: ProjectId.make("project-stale"),
      workspaceRoot: "/tmp/shared-repo/",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const canonical = makeProject({
      id: ProjectId.make("project-canonical"),
      workspaceRoot: "/tmp/shared-repo",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    const snapshots = buildSidebarProjectSnapshots({
      projects: [staleDuplicate, canonical],
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => "primary",
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.memberProjects.map((project) => project.id)).toEqual([canonical.id]);
    expect(snapshots[0]?.id).toBe(canonical.id);

    const [pickerEntry] = buildSidebarProjectPickerEntries({
      groups: snapshots,
      preferredProjectRef: { environmentId: primaryEnvironmentId, projectId: staleDuplicate.id },
    });
    expect(pickerEntry?.isPreferred).toBe(true);
    expect(pickerEntry?.targetProject.id).toBe(canonical.id);
  });

  it("puts the preferred project's picker entry first", () => {
    const local = makeProject();
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      title: "remote",
    });
    const groups = buildSidebarProjectSnapshots({
      projects: [local, remote],
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    const entries = buildSidebarProjectPickerEntries({
      groups,
      preferredProjectRef: { environmentId: remoteEnvironmentId, projectId: remote.id },
    });

    expect(entries.map((entry) => [entry.group.displayName, entry.isPreferred])).toEqual([
      ["remote", true],
      ["shared-repo", false],
    ]);
    expect(entries[0]?.targetProject).toMatchObject({
      environmentId: remoteEnvironmentId,
      id: remote.id,
    });
  });

  it("keeps manual project order when building sidebar entries", () => {
    const primary = makeProject();
    const separate = makeProject({
      id: ProjectId.make("project-separate"),
      title: "separate",
      workspaceRoot: "/tmp/separate",
    });
    const orderedProjects = orderItemsByPreferredIds({
      items: [primary, separate],
      preferredIds: [getProjectOrderKey(separate), getProjectOrderKey(primary)],
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });

    const groups = buildSidebarProjectSnapshots({
      projects: orderedProjects,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    expect(groups.map((group) => group.displayName)).toEqual(["separate", "shared-repo"]);
  });
});
