import { scopedProjectKey, scopeProjectRef } from "../environment/scoped.ts";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";

import type { EnvironmentProject } from "./models.ts";
import { normalizeProjectPathForComparison } from "./projects.ts";

const SCRATCH_PROJECT_SCOPE_KEY = "\0no-project";

export function derivePhysicalProjectKeyFromPath(environmentId: string, cwd: string): string {
  return `${environmentId}:${normalizeProjectPathForComparison(cwd)}`;
}

export function derivePhysicalProjectKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKeyFromPath(project.environmentId, project.workspaceRoot);
}

export function getProjectOrderKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKey(project);
}

/** One group per project folder; scratch projects share one group when asked. */
export function deriveLogicalProjectKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot" | "isScratch">,
  options?: { readonly groupScratchProjects?: boolean },
): string {
  if (options?.groupScratchProjects && project.isScratch) return SCRATCH_PROJECT_SCOPE_KEY;
  return derivePhysicalProjectKey(project);
}

/** Resolves a scratch filter selected before its environment config identified the project. */
export function resolveScratchProjectScopeKey(
  key: string | null,
  projects: ReadonlyArray<
    Pick<EnvironmentProject, "environmentId" | "workspaceRoot" | "isScratch">
  >,
): string | null {
  if (key === null || key === SCRATCH_PROJECT_SCOPE_KEY) return key;
  return projects.some((project) => project.isScratch && derivePhysicalProjectKey(project) === key)
    ? SCRATCH_PROJECT_SCOPE_KEY
    : key;
}

export interface ProjectGroupMember<TProject extends EnvironmentProject = EnvironmentProject> {
  readonly physicalProjectKey: string;
  readonly project: TProject;
}

export interface ProjectGroup<TProject extends EnvironmentProject = EnvironmentProject> {
  readonly key: string;
  readonly label: string;
  readonly representative: TProject;
  readonly members: ReadonlyArray<ProjectGroupMember<TProject>>;
  readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
}

function projectFreshnessTime(project: EnvironmentProject): number {
  const updatedAtTime = Date.parse(project.updatedAt);
  if (Number.isFinite(updatedAtTime)) {
    return updatedAtTime;
  }
  const createdAtTime = Date.parse(project.createdAt);
  return Number.isFinite(createdAtTime) ? createdAtTime : 0;
}

function shouldReplacePhysicalProjectWinner<TProject extends EnvironmentProject>(
  existing: TProject,
  candidate: TProject,
): boolean {
  const freshnessDelta = projectFreshnessTime(candidate) - projectFreshnessTime(existing);
  return freshnessDelta > 0 || (freshnessDelta === 0 && candidate.id > existing.id);
}

/**
 * Builds logical project groups without losing the physical projects that
 * remain the actual navigation and task-creation targets.
 *
 * Presentation-specific metadata, filtering, and activity sorting stay in
 * each client. Physical deduplication, labels, and member preservation live
 * here so web and mobile cannot drift.
 */
export function buildProjectGroups<TProject extends EnvironmentProject>(input: {
  readonly projects: ReadonlyArray<TProject>;
  readonly preferredEnvironmentId?: EnvironmentId | null;
  /** Filter equivalence does not change the default ownership of mutable project settings. */
  readonly groupScratchProjects?: boolean;
}): ReadonlyArray<ProjectGroup<TProject>> {
  const projectsByPhysicalKey = new Map<string, TProject[]>();
  for (const project of input.projects) {
    const physicalProjectKey = derivePhysicalProjectKey(project);
    const existing = projectsByPhysicalKey.get(physicalProjectKey);
    if (existing) {
      existing.push(project);
    } else {
      projectsByPhysicalKey.set(physicalProjectKey, [project]);
    }
  }

  const logicalKeyByPhysicalKey = new Map<string, string>();
  const groupedMembers = new Map<string, ProjectGroupMember<TProject>[]>();
  for (const [physicalProjectKey, physicalProjects] of projectsByPhysicalKey) {
    const winner = physicalProjects.reduce((current, candidate) =>
      shouldReplacePhysicalProjectWinner(current, candidate) ? candidate : current,
    );
    const logicalKey = deriveLogicalProjectKey(winner, {
      groupScratchProjects: input.groupScratchProjects ?? false,
    });
    logicalKeyByPhysicalKey.set(physicalProjectKey, logicalKey);
    const member = { physicalProjectKey, project: winner };
    const existing = groupedMembers.get(logicalKey);
    if (existing) {
      existing.push(member);
    } else {
      groupedMembers.set(logicalKey, [member]);
    }
  }

  const projectRefsByLogicalKey = new Map<string, ScopedProjectRef[]>();
  const seenProjectRefs = new Set<string>();
  for (const project of input.projects) {
    const physicalProjectKey = derivePhysicalProjectKey(project);
    const logicalKey =
      logicalKeyByPhysicalKey.get(physicalProjectKey) ??
      deriveLogicalProjectKey(project, {
        groupScratchProjects: input.groupScratchProjects ?? false,
      });
    const projectRefKey = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
    if (seenProjectRefs.has(projectRefKey)) continue;
    seenProjectRefs.add(projectRefKey);
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    const existing = projectRefsByLogicalKey.get(logicalKey);
    if (existing) {
      existing.push(projectRef);
    } else {
      projectRefsByLogicalKey.set(logicalKey, [projectRef]);
    }
  }

  const preferredEnvironmentId = input.preferredEnvironmentId ?? null;
  return Array.from(groupedMembers, ([key, members]) => {
    const representative =
      (preferredEnvironmentId
        ? members.find((member) => member.project.environmentId === preferredEnvironmentId)?.project
        : null) ?? members[0]!.project;
    return {
      key,
      label:
        input.groupScratchProjects && representative.isScratch
          ? "No project"
          : representative.title,
      representative,
      members,
      memberProjectRefs: projectRefsByLogicalKey.get(key) ?? [],
    };
  });
}
