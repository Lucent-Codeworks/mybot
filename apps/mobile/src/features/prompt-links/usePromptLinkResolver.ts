import { StackActions, useNavigation } from "@react-navigation/native";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import { resolvePromptLinkModelSelection } from "@t3tools/client-runtime/prompt-links";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { parseNewThreadLink, type LinkedPrompt } from "@t3tools/shared/promptLinks";
import { useEffect, useEffectEvent, useRef } from "react";
import { Alert } from "react-native";

import { useServerConfigs, useThreadShells } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createNewTaskDraft,
  setComposerDraftText,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useWorkspaceState } from "../../state/workspace";
import { showPromptLinkNotice } from "./prompt-link-actions";
import {
  clearedPromptLinkParams,
  promptLinkNotice,
  latestThreadEnvironmentIds,
  promptLinkScratchEnvironmentId,
  promptLinkSearchFromParams,
} from "./prompt-link-model";

/** What a `new` link asks for, in one shape for every destination. */
type LinkedDraftRequest = {
  readonly prompt: LinkedPrompt;
  readonly provider: string | null;
  readonly model: string | null;
};

/**
 * Opens a `t3code://new?…` link. The link lands on the New Task picker with its query as route
 * params; this opens a draft without a project on the most recently used machine and fills it. Nothing is
 * ever sent: the user reads the prompt and presses Send. Used by `NewTaskRouteScreen`.
 */
export function usePromptLinkResolver(params: Readonly<Record<string, unknown>> | undefined) {
  const navigation = useNavigation();
  const { state: catalogState } = useWorkspaceState();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const search = promptLinkSearchFromParams(params);
  // A cold launch from a link has no threads yet, so the most recent machine is unknown.
  const waitingForShells =
    catalogState.isLoadingConnections ||
    catalogState.hasPendingShellSnapshot ||
    // A machine still connecting may be the most recent one. One that keeps failing to
    // reconnect has settled offline, and must not hold every link.
    catalogState.connectingEnvironments.some(
      (environment) =>
        environment.connectionState === "connecting" || environment.connectionError === null,
    );

  // Writes the prompt and the requested model into a draft. Returns true when the link named a
  // model the user cannot use, so their default stands in.
  const writeDraft = (
    draftKey: string,
    environmentId: EnvironmentId,
    request: LinkedDraftRequest,
  ): boolean => {
    setComposerDraftText(draftKey, request.prompt.text);
    if (request.provider === null) return false;
    const resolved = resolvePromptLinkModelSelection(
      serverConfigs.get(environmentId)?.providers ?? [],
      { provider: request.provider, model: request.model },
    );
    if (resolved) updateComposerDraftSettings(draftKey, { modelSelection: resolved.selection });
    return resolved?.exact !== true;
  };

  const openProjectDraft = async (project: EnvironmentProject, request: LinkedDraftRequest) => {
    try {
      await waitForComposerDraftsLoaded();
    } catch {
      Alert.alert(
        "Could not open link",
        "Drafts could not be loaded, so the prompt was not added.",
      );
      return;
    }
    const draftKey = createNewTaskDraft({
      environmentId: project.environmentId,
      projectId: project.id,
    });
    const modelUnavailable = writeDraft(draftKey, project.environmentId, request);
    navigation.dispatch(
      StackActions.push("NewTaskDraft", {
        draftId: draftKey,
        title: project.title,
      }),
    );
    showPromptLinkNotice(
      promptLinkNotice({ hiddenCharacters: request.prompt.hiddenCharacters, modelUnavailable }),
    );
  };

  const openScratchDraft = async (request: LinkedDraftRequest) => {
    const environmentId = promptLinkScratchEnvironmentId(
      // Machines by their latest thread, scratch threads included.
      latestThreadEnvironmentIds(threads),
      connectedEnvironments
        .filter(
          (environment) =>
            availableScratchWorkspaceRoot(
              environment.connectionState,
              serverConfigs.get(environment.environmentId),
            ) !== null,
        )
        .map((environment) => environment.environmentId),
    );
    if (environmentId === null) {
      Alert.alert(
        "Could not start without a project",
        "No connected environment offers threads without a project.",
      );
      return;
    }
    const result = await openScratch({ environmentId, input: {} });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Could not start without a project",
          error instanceof Error
            ? error.message
            : "The folder for threads without a project could not be created.",
        );
      }
      return;
    }
    await openProjectDraft(result.value, request);
  };

  const resolveLink = useEffectEvent((linkSearch: string) => {
    const parsed = parseNewThreadLink(linkSearch);
    if (!parsed.ok) {
      Alert.alert("Could not open link", parsed.error);
      return;
    }
    const link = parsed.value;
    void openScratchDraft({ prompt: link.prompt, provider: link.provider, model: link.model });
  });

  // Handle each link once. Clearing the params lets the same link open again later.
  const handledSearchRef = useRef<string | null>(null);
  useEffect(() => {
    if (search === null) {
      handledSearchRef.current = null;
      return;
    }
    if (waitingForShells || handledSearchRef.current === search) return;
    handledSearchRef.current = search;
    navigation.setParams(clearedPromptLinkParams());
    resolveLink(search);
  }, [navigation, search, waitingForShells]);
}
