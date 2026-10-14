import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import {
  buildShowcasePendingTasks,
  SHOWCASE_PENDING_TASK_DEFINITIONS,
} from "./showcasePendingTasks";

const projects: ReadonlyArray<EnvironmentProject> = [
  {
    environmentId: EnvironmentId.make("moonbase-terminal"),
    id: ProjectId.make("t3code"),
    title: "MyBot",
    workspaceRoot: "/workspace/t3code",
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    scripts: [],
    createdAt: "2026-07-16T08:00:00.000Z",
    updatedAt: "2026-07-16T08:00:00.000Z",
  },
  {
    environmentId: EnvironmentId.make("suspense-station"),
    id: ProjectId.make("react"),
    title: "React",
    workspaceRoot: "/workspace/react",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-16T08:00:00.000Z",
    updatedAt: "2026-07-16T08:00:00.000Z",
  },
];

it("builds sendable-looking pending tasks against real showcase projects", () => {
  const tasks = buildShowcasePendingTasks(projects, Date.parse("2026-07-16T09:00:00.000Z"));

  assert.equal(tasks.length, SHOWCASE_PENDING_TASK_DEFINITIONS.length);
  assert.deepStrictEqual(
    tasks.map((task) => ({
      environmentId: String(task.environmentId),
      projectId: task.creation ? String(task.creation.projectId) : undefined,
      title: task.creation?.projectTitle,
      createdAt: task.createdAt,
    })),
    [
      {
        environmentId: "moonbase-terminal",
        projectId: "t3code",
        title: "MyBot",
        createdAt: "2026-07-16T08:52:00.000Z",
      },
      {
        environmentId: "suspense-station",
        projectId: "react",
        title: "React",
        createdAt: "2026-07-16T08:33:00.000Z",
      },
    ],
  );
  assert.equal(
    tasks.every((task) => task.modelSelection !== undefined),
    true,
  );
});

it("waits until every referenced project has hydrated", () => {
  assert.equal(buildShowcasePendingTasks(projects.slice(0, 1), Date.now()).length, 1);
});
