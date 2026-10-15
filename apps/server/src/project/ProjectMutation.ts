import { type ProjectMutation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BuiltInMyBot from "../bots/BuiltInMyBot.ts";
import {
  ProjectBotRequiredError,
  ProjectBuiltInError,
  type ProjectService,
} from "./ProjectService.ts";

type ProjectMutations = Pick<ProjectService["Service"], "create" | "delete" | "update" | "getById">;

/**
 * Every project is a bot, so a create needs a bot profile and an update cannot
 * remove it. The built-in MyBot cannot be deleted or replaced.
 */
export const projectMutationOperation = Effect.fn("projectMutationOperation")(function* (
  projects: ProjectMutations,
  mutation: ProjectMutation,
) {
  switch (mutation.type) {
    case "project.create":
      if (mutation.bot == null) {
        return yield* new ProjectBotRequiredError({ projectId: mutation.projectId });
      }
      if (mutation.bot.orchestrator === true) {
        return yield* new ProjectBuiltInError({
          projectId: mutation.projectId,
          reason: "orchestrator",
        });
      }
      return yield* projects.create({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        title: mutation.title,
        workspaceRoot: mutation.workspaceRoot,
        ...(mutation.createWorkspaceRootIfMissing === undefined
          ? {}
          : { createWorkspaceRootIfMissing: mutation.createWorkspaceRootIfMissing }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        bot: mutation.bot,
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      });

    case "project.update": {
      if (mutation.bot === null) {
        return yield* new ProjectBotRequiredError({ projectId: mutation.projectId });
      }
      const bot = yield* BuiltInMyBot.guardedBotProfile(projects, mutation.projectId, mutation.bot);
      return yield* projects.update({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.title === undefined ? {} : { title: mutation.title }),
        ...(mutation.workspaceRoot === undefined ? {} : { workspaceRoot: mutation.workspaceRoot }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.projectIcon === undefined ? {} : { projectIcon: mutation.projectIcon }),
        ...(mutation.faviconPath === undefined ? {} : { faviconPath: mutation.faviconPath }),
        ...(bot === undefined ? {} : { bot }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      });
    }

    case "project.delete":
      yield* BuiltInMyBot.assertDeletable(projects, mutation.projectId);
      return yield* projects.delete({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.force === undefined ? {} : { force: mutation.force }),
      });
  }
});
