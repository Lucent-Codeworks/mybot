import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  BotProfile,
  EnvironmentId,
  ModelSelection,
  ProjectIconOverride,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { waitForProject } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "An error occurred.";
}

/**
 * Creates a bot. The server makes its folder under `newProjectsRoot`; this
 * then opens a new chat with it. `defaultModelSelection` is the model its
 * chats start with.
 *
 * Resolves to whether the bot was created.
 */
export function useNewBot() {
  const createNew = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  return useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly name: string;
      readonly bot: BotProfile;
      readonly defaultModelSelection?: ModelSelection;
      readonly projectIcon?: ProjectIconOverride;
      readonly templateId?: string;
    }): Promise<boolean> => {
      const result = await createNew({
        environmentId: input.environmentId,
        input: {
          name: input.name,
          bot: input.bot,
          ...(input.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: input.defaultModelSelection }),
          ...(input.projectIcon === undefined ? {} : { projectIcon: input.projectIcon }),
          ...(input.templateId === undefined ? {} : { templateId: input.templateId }),
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create the bot",
              description: errorMessage(squashAtomCommandFailure(result)),
            }),
          );
        }
        return false;
      }

      const { projectId, workspaceRoot } = result.value;
      // The folder sits in MyBot's data directory, so always say where.
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: `Created ${input.name}`,
          description: workspaceRoot,
        }),
      );

      const projectRef = scopeProjectRef(input.environmentId, projectId);
      // Drafts key off the project's stored path, so wait for the create event
      // to reach the store before opening one.
      const project = await waitForProject(projectRef).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open the bot",
            description: `${errorMessage(error)} It will appear in the sidebar once this client catches up.`,
          }),
        );
        return null;
      });
      if (project === null) return true;
      await handleNewThread(projectRef).catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open the bot",
            description: errorMessage(error),
          }),
        );
      });
      return true;
    },
    [createNew, handleNewThread],
  );
}
