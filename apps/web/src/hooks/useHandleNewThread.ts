import { useAtomValue } from "@effect/atom-react";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@mybot/client-runtime/environment";
import { DEFAULT_SERVER_SETTINGS, type ScopedProjectRef, type ThreadId } from "@mybot/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import {
  composerDraftHasUserContent,
  markPromotedDraftThreadByRef,
  type DraftId,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { deriveLogicalProjectKey, getProjectOrderKey } from "../logicalProject";
import { resolveProjectSettings } from "@mybot/shared/projectSettings";
import { readProjects, readThreadShell, useProjects, useThreadShell } from "../state/entities";
import {
  hasExplicitComposerModelSelection,
  resolveNewThreadModelSelectionOverride,
} from "../lib/chatThreadActions";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";

export function useNewThreadHandler() {
  const environmentServerConfigs = useAtomValue(environmentServerConfigsAtom);
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    (
      projectRef: ScopedProjectRef,
      options?: { replace?: boolean },
      // Which draft the thread ended up in, so a caller that has something to put in it — a
      // task to write — addresses that one rather than looking the project up again and
      // finding whichever draft it happens to hold.
    ): Promise<{ draftId: DraftId; threadId: ThreadId } | null> => {
      const projects = readProjects();
      const targetServerSettings =
        environmentServerConfigs.get(projectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
      const {
        getComposerDraft,
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        applyStickyState,
        setLogicalProjectDraftThreadId,
        setModelSelection,
      } = useComposerDraftStore.getState();
      const currentRouteTarget = getCurrentRouteTarget();
      // A new thread carries the user's working mode from the thread being
      // viewed. The target project's configured model still wins; interaction
      // mode carries independently. Permissions come from configured defaults.
      const carrySourceShell =
        currentRouteTarget?.kind === "server"
          ? readThreadShell(currentRouteTarget.threadRef)
          : null;
      const carrySourceDraft =
        currentRouteTarget?.kind === "draft" ? getDraftSession(currentRouteTarget.draftId) : null;
      // Composer overrides win over the persisted thread state — they are
      // what the user currently sees in the composer controls.
      const carrySourceComposer = currentRouteTarget
        ? getComposerDraft(
            currentRouteTarget.kind === "server"
              ? currentRouteTarget.threadRef
              : currentRouteTarget.draftId,
          )
        : null;
      const composerActiveProvider = carrySourceComposer?.activeProvider ?? null;
      const composerModelSelection = composerActiveProvider
        ? (carrySourceComposer?.modelSelectionByProvider[composerActiveProvider] ?? null)
        : null;
      const carryModelSelection =
        composerModelSelection ?? carrySourceShell?.modelSelection ?? null;
      const carryInteractionMode =
        carrySourceComposer?.interactionMode ??
        carrySourceShell?.interactionMode ??
        carrySourceDraft?.interactionMode ??
        null;
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      // The resolver applies project overrides and, until the server has
      // folded them, the aggregate's own legacy fields.
      const projectSettings = resolveProjectSettings(
        targetServerSettings,
        project?.id ?? null,
        project,
      );
      const projectDefaultModelSelection = projectSettings.settings.defaultModelSelection;
      const defaultRuntimeMode = projectSettings.settings.defaultRuntimeMode;
      const resolveModelSelectionOverride = (destinationDraftId: DraftId) =>
        resolveNewThreadModelSelectionOverride({
          projectDefaultSelection: projectDefaultModelSelection ?? null,
          carrySelection: carryModelSelection,
          carrySourceDraftId:
            currentRouteTarget?.kind === "draft" ? currentRouteTarget.draftId : null,
          destinationDraftId,
        });
      const logicalProjectKey = project
        ? deriveLogicalProjectKey(project)
        : scopedProjectKey(projectRef);
      const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      const storedDraftThreadRef = storedDraftThread
        ? scopeThreadRef(storedDraftThread.environmentId, storedDraftThread.threadId)
        : null;
      const reusableStoredDraftThread =
        storedDraftThread !== null &&
        storedDraftThread.promotedTo == null &&
        storedDraftThreadRef !== null &&
        readThreadShell(storedDraftThreadRef) === null
          ? storedDraftThread
          : null;
      if (storedDraftThreadRef && reusableStoredDraftThread === null) {
        markPromotedDraftThreadByRef(storedDraftThreadRef);
      }
      // New-thread surfaces (button, hotkeys, "/" landing, palette) only
      // ever reuse a draft the user has NOT invested in. A draft with typed
      // text or attachments is work in progress: it stays alive where it is
      // (reachable from the sidebar draft rows) and this request mints a
      // fresh draft instead — the remap in the store preserves invested
      // drafts rather than deleting them.
      const emptyStoredDraftThread =
        reusableStoredDraftThread &&
        !composerDraftHasUserContent(getComposerDraft(reusableStoredDraftThread.draftId))
          ? reusableStoredDraftThread
          : null;
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === "server"
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null;
      if (emptyStoredDraftThread) {
        return (async () => {
          const isDraftAlreadyOpen =
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === emptyStoredDraftThread.draftId;
          // Model intent: an explicit human pick always stands. Seeds and
          // legacy entries alike re-resolve here — sticky first, mirroring
          // the mint-fresh path, then the project default or carried
          // selection on top. This runs even when the draft is already open:
          // without it, a changed pin could never reach the draft the user
          // is looking at, because explicit picks are the only thing the
          // flag protects.
          const storedDraft = getComposerDraft(emptyStoredDraftThread.draftId);
          const storedDraftHasExplicitModelPick = hasExplicitComposerModelSelection(storedDraft);
          if (!storedDraftHasExplicitModelPick) {
            applyStickyState(emptyStoredDraftThread.draftId);
            const modelSelectionOverride = resolveModelSelectionOverride(
              emptyStoredDraftThread.draftId,
            );
            if (modelSelectionOverride) {
              // This is a complete snapshot: absent options mean "no options",
              // not "keep the stale draft's options".
              setModelSelection(emptyStoredDraftThread.draftId, modelSelectionOverride, {
                replaceOptions: true,
              });
            }
          }
          // Resurrecting an empty stored draft resets its permissions to the
          // configured default and carries the viewed thread's interaction
          // mode. When the draft is already open, its permissions stay — the
          // user may have just changed them in the composer.
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            emptyStoredDraftThread.draftId,
            {
              threadId: emptyStoredDraftThread.threadId,
              ...(!isDraftAlreadyOpen ? { runtimeMode: defaultRuntimeMode } : {}),
              ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
            },
          );
          const opened = {
            draftId: emptyStoredDraftThread.draftId,
            threadId: emptyStoredDraftThread.threadId,
          };
          if (isDraftAlreadyOpen) {
            return opened;
          }
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: emptyStoredDraftThread.draftId },
            replace: options?.replace ?? false,
          });
          return opened;
        })();
      }

      if (
        latestActiveDraftThread &&
        currentRouteTarget?.kind === "draft" &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.promotedTo == null &&
        // Same content rule as above: a new-thread request while viewing an
        // invested draft mints a fresh one instead of repurposing it.
        !composerDraftHasUserContent(getComposerDraft(currentRouteTarget.draftId))
      ) {
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
        });
        return Promise.resolve({
          draftId: currentRouteTarget.draftId,
          threadId: latestActiveDraftThread.threadId,
        });
      }

      const draftId = newDraftId();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          runtimeMode: defaultRuntimeMode,
          ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
        });
        applyStickyState(draftId);
        const modelSelectionOverride = resolveModelSelectionOverride(draftId);
        if (modelSelectionOverride) {
          // Project defaults and carried selections both outrank global sticky
          // state. The project default wins when both are present.
          setModelSelection(draftId, modelSelectionOverride, { replaceOptions: true });
        }
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          replace: options?.replace ?? false,
        });
        return { draftId, threadId };
      })();
    },
    [environmentServerConfigs, getCurrentRouteTarget, router],
  );
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const activeThread = useThreadShell(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadHandler();

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef: orderedProjects[0]
      ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
      : null,
    handleNewThread,
    routeDraftId,
    routeThreadRef,
  };
}
