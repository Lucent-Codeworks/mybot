import { assert, it } from "@effect/vitest";
import {
  type OrchestrationProjectShell,
  ProjectId,
  type ProjectCreateNewInput,
} from "@mybot/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as BuiltInMyBot from "./BuiltInMyBot.ts";

const shell = (id: string, bot: OrchestrationProjectShell["bot"]): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot: `/projects/${id}`,
  defaultModelSelection: null,
  bot,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

it.effect("creates the built-in MyBot once and finds it afterwards", () =>
  Effect.gen(function* () {
    const shells: Array<OrchestrationProjectShell> = [
      shell("scout", { role: "Research", instructions: "" }),
    ];
    const created: Array<ProjectCreateNewInput> = [];
    const layer = Layer.mergeAll(
      Layer.mock(ProjectService.ProjectService)({
        listShells: () => Effect.sync(() => [...shells]),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        scratchRoot: "/scratch",
        namedProjectsRoot: "/projects",
        createNamedProject: (input) =>
          Effect.sync(() => {
            created.push(input);
            shells.push(shell("mybot", input.bot ?? null));
            return { projectId: ProjectId.make("mybot"), workspaceRoot: "/projects/mybot" };
          }),
      }),
    );

    const first = yield* BuiltInMyBot.ensureBuiltInMyBot().pipe(Effect.provide(layer));
    const second = yield* BuiltInMyBot.ensureBuiltInMyBot().pipe(Effect.provide(layer));

    assert.equal(first, "mybot");
    assert.equal(second, "mybot");
    // No model override, so it follows the user's default model.
    assert.deepEqual(created, [
      {
        name: "MyBot",
        bot: { role: "Your assistant", instructions: "", orchestrator: true },
        projectIcon: { kind: "lucide", name: "sparkles", color: "violet" },
      },
    ]);
  }),
);

it("keeps the flag out of new bots", () => {
  assert.deepEqual(
    BuiltInMyBot.withoutOrchestrator({ role: "Inbox", instructions: "", orchestrator: true }),
    { role: "Inbox", instructions: "" },
  );
  assert.isUndefined(BuiltInMyBot.withoutOrchestrator(undefined));
});
