import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { projectMutationOperation } from "./ProjectMutation.ts";
import { ProjectBotRequiredError, type ProjectService } from "./ProjectService.ts";

const projectId = ProjectId.make("project:mutation-mapping");
const project = {
  id: projectId,
  title: "Mapping",
  workspaceRoot: "/work/mapping",
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  deletedAt: null,
} satisfies Project;
const bot = { role: "", instructions: "" };

const recordingProjects = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const projects: Pick<ProjectService["Service"], "create" | "delete" | "update"> = {
    create: (input) => Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
    update: (input) => Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
    delete: (input) => Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
  };
  return { calls, projects };
});

it.effect("preserves every project mutation field", () =>
  Effect.gen(function* () {
    const { calls, projects } = yield* recordingProjects;

    yield* projectMutationOperation(projects, {
      type: "project.create",
      commandId: CommandId.make("command:create"),
      projectId,
      title: "Created",
      workspaceRoot: "/work/created",
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: null,
      bot,
      scripts: [],
    });
    yield* projectMutationOperation(projects, {
      type: "project.update",
      commandId: CommandId.make("command:update"),
      projectId,
      title: "Updated",
      workspaceRoot: "/work/updated",
      defaultModelSelection: null,
      projectIcon: null,
      faviconPath: null,
      scripts: [],
    });
    yield* projectMutationOperation(projects, {
      type: "project.delete",
      commandId: CommandId.make("command:delete"),
      projectId,
      force: true,
    });

    assert.deepEqual(yield* Ref.get(calls), [
      {
        commandId: "command:create",
        projectId,
        title: "Created",
        workspaceRoot: "/work/created",
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
        bot,
        scripts: [],
      },
      {
        commandId: "command:update",
        projectId,
        title: "Updated",
        workspaceRoot: "/work/updated",
        defaultModelSelection: null,
        projectIcon: null,
        faviconPath: null,
        scripts: [],
      },
      { commandId: "command:delete", projectId, force: true },
    ]);
  }),
);

it.effect("rejects a project without a bot and an update that removes the bot", () =>
  Effect.gen(function* () {
    const { calls, projects } = yield* recordingProjects;
    const create = {
      type: "project.create" as const,
      commandId: CommandId.make("command:create-plain"),
      projectId,
      title: "Plain",
      workspaceRoot: "/work/plain",
    };

    for (const mutation of [
      create,
      { ...create, bot: null },
      {
        type: "project.update" as const,
        commandId: CommandId.make("command:unbot"),
        projectId,
        bot: null,
      },
    ]) {
      const error = yield* projectMutationOperation(projects, mutation).pipe(Effect.flip);
      assert.instanceOf(error, ProjectBotRequiredError);
      assert.equal(error.message, "MyBot only has bots: give the project a bot profile.");
    }
    assert.deepEqual(yield* Ref.get(calls), []);
  }),
);
