import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";

import type {
  EnvironmentId,
  ModelSelection,
  ProviderInteractionMode,
  ProviderOptionSelection,
  RuntimeMode,
  ServerProvider,
} from "@mybot/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ThreadId,
} from "@mybot/contracts";
import { resolveProjectSettings } from "@mybot/shared/projectSettings";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";

import {
  useEnvironmentServerConfig,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import type { TurnCommandMetadata } from "../../lib/commandMetadata";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import {
  buildModelOptions,
  groupByProvider,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
  resolveSelectableModelSelection,
} from "../../lib/modelOptions";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  appendComposerDraftAttachments,
  type ComposerDraftInsertion,
  clearComposerDraft,
  composerDraftsAtom,
  createNewTaskDraft,
  getComposerDraftSnapshot,
  isComposerDraftEmpty,
  isNewTaskDraftKey,
  removeComposerDraftAttachment,
  replaceComposerDraftAttachments,
  retargetNewTaskDraft,
  scheduleUnusedComposerAttachmentCleanup,
  setComposerDraftText,
  setComposerDraftContext,
  setStickyComposerModelSelection,
  updateComposerDraftSettings,
  useComposerDraft,
  useStickyComposerModelSelection,
} from "../../state/use-composer-drafts";
import {
  capturePendingTaskEditorWriteBaseline,
  flushPendingTaskEditorWrite,
} from "../../state/pending-task-editor-writes";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import {
  flattenQueuedThreadMessages,
  threadOutboxManager,
  type QueuedThreadMessage,
} from "../../state/thread-outbox";
import {
  holdEditingQueuedMessage,
  releaseEditingQueuedMessage,
  useThreadOutboxMessages,
} from "../../state/use-thread-outbox";
import {
  useRemoteConnectionStatus,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { availableScratchWorkspaceRoot } from "@mybot/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@mybot/client-runtime/state/runtime";
import { isScratchProject } from "@mybot/client-runtime/state/projects";
import { EnvironmentProject } from "@mybot/client-runtime/state/shell";
import {
  buildHomeProjectScopes,
  sortHomeProjectScopes,
  type HomeProjectScope,
} from "../home/homeThreadList";
import {
  resolvePendingTaskInteractionMode,
  resolveProviderInteractionMode,
} from "../../state/legacy-plan-mode";
import { useLegacyPlanModeState } from "./use-legacy-plan-mode-enabled";
import { resolveEnvironmentProjectMatch } from "./new-task-project-selection";

function pendingTaskDraftKey(messageId: string): string {
  return `pending-task:${messageId}`;
}

// The message id owned by the currently active editing session, tracked
// across provider instances. An in-flight flush from a dismissed session
// consults it so it never drops the draft or releases the drain lock out from
// under a newer session editing the same task.
let activeEditingMessageId: string | null = null;

function findQueuedPendingTask(messageId: string): QueuedThreadMessage | null {
  const message = flattenQueuedThreadMessages(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).find((candidate) => candidate.messageId === messageId);
  return message?.creation !== undefined ? message : null;
}

type NewTaskFlowContextValue = {
  readonly projectScopes: ReadonlyArray<HomeProjectScope>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly selectedModelKey: string | null;
  readonly draftKey: string | null;
  readonly editingPendingTask: QueuedThreadMessage | null;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly submitting: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly planModeEnabled: boolean;
  readonly expandedProvider: string | null;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
  }>;
  readonly selectedProject: EnvironmentProject | null;
  /** True when the draft is a thread without a project (its machine's Scratch project). */
  readonly isScratchDraft: boolean;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly selectedModel: ModelSelection | null;
  readonly selectedModelOption: ModelOption | null;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly reset: () => void;
  readonly setProject: (project: EnvironmentProject) => void;
  /**
   * Binds the composer to an existing new-task draft (a row in the thread
   * list). Returns false when the draft is gone, so the caller can fall back
   * to a fresh one.
   */
  readonly openDraft: (draftKey: string) => boolean;
  readonly selectEnvironment: (environmentId: EnvironmentId) => void;
  /**
   * Moves the draft to another machine. A draft without a project resolves to
   * that machine's "No project" folder first, creating it when needed.
   */
  readonly switchEnvironment: (environmentId: EnvironmentId) => Promise<boolean>;
  /** The machine a switch in progress is heading to. */
  readonly switchingToEnvironmentId: EnvironmentId | null;
  readonly setSelectedModelKey: (
    key: string | null,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => void;
  readonly beginEditingPendingTask: (messageId: string) => boolean;
  readonly finishEditingPendingTask: () => void;
  readonly cancelEditingPendingTask: () => void;
  readonly buildPendingTaskMessage: (metadata: TurnCommandMetadata) => QueuedThreadMessage | null;
  readonly setPrompt: (value: string) => void;
  readonly replaceAttachments: (attachments: ReadonlyArray<DraftComposerAttachment>) => void;
  /** Appends draft attachments; returns how many the live cap rejected. */
  readonly appendAttachments: (
    attachments: ReadonlyArray<DraftComposerAttachment>,
    insertion?: ComposerDraftInsertion,
  ) => number;
  readonly removeAttachment: (imageId: string) => void;
  readonly clearAttachments: () => void;
  readonly setSubmitting: (value: boolean) => void;
  readonly setRuntimeMode: (value: RuntimeMode) => void;
  readonly setInteractionMode: (value: ProviderInteractionMode) => void;
  readonly setSelectedModelOptions: (
    value: ReadonlyArray<ProviderOptionSelection> | undefined,
  ) => void;
  readonly setExpandedProvider: (value: string | null) => void;
};

const NewTaskFlowContext = React.createContext<NewTaskFlowContextValue | null>(null);

export function NewTaskFlowProvider(props: React.PropsWithChildren) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { enabled: legacyPlanModeEnabled, loaded: planModePreferenceLoaded } =
    useLegacyPlanModeState();

  const projectScopes = useMemo(
    () =>
      sortHomeProjectScopes({
        scopes: buildHomeProjectScopes({
          projects,
          environmentId: null,
        }),
        threads,
        pendingTasks: [],
        projectSortOrder: "updated_at",
      }),
    [projects, threads],
  );

  const [selectedEnvironmentIdOverride, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const selectedEnvironmentId =
    selectedEnvironmentIdOverride !== null &&
    projects.some((project) => project.environmentId === selectedEnvironmentIdOverride)
      ? selectedEnvironmentIdOverride
      : (projects[0]?.environmentId ?? null);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  // The new-task draft the composer is bound to. Null until a project is
  // chosen; each New Task entry mints its own, so a project can hold several.
  const [activeDraftKey, setActiveDraftKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [editingPendingTask, setEditingPendingTask] = useState<QueuedThreadMessage | null>(null);
  // Mirrors `editingPendingTask` synchronously so the unmount flush cannot act
  // on a task whose editing session already ended this render.
  const editingPendingTaskRef = useRef<QueuedThreadMessage | null>(null);
  // Outbox revision this editor session may write after its predecessor save.
  // Unrelated accepted writes still beat the dismissed session's CAS.
  const editingRevisionRef = useRef(Promise.resolve(0));

  const reset = useCallback(() => {
    setSelectedEnvironmentId(null);
    setSelectedProjectKey(null);
    setActiveDraftKey(null);
    setSubmitting(false);
    setExpandedProvider(null);
    const editing = editingPendingTaskRef.current;
    editingPendingTaskRef.current = null;
    setEditingPendingTask(null);
    if (editing) {
      if (activeEditingMessageId === editing.messageId) {
        activeEditingMessageId = null;
      }
      releaseEditingQueuedMessage(editing.messageId);
    }
  }, []);

  const projectsForEnvironment = useMemo(
    () =>
      pipe(
        projects,
        Arr.filter((project) => project.environmentId === selectedEnvironmentId),
      ),
    [projects, selectedEnvironmentId],
  );

  // Stand-in for the edited task's project while its shell is not loaded
  // (environment offline / still synchronizing), built from the metadata
  // snapshotted at enqueue time.
  const editingPendingProject = useMemo<EnvironmentProject | null>(() => {
    const creation = editingPendingTask?.creation;
    if (!editingPendingTask || !creation) {
      return null;
    }
    return {
      environmentId: editingPendingTask.environmentId,
      id: creation.projectId,
      title: creation.projectTitle ?? "Unknown project",
      // Deliberately empty when the snapshot has no cwd — downstream consumers
      // must skip it, not receive a fabricated path.
      workspaceRoot: creation.projectCwd ?? "",
      defaultModelSelection: editingPendingTask.modelSelection ?? null,
      scripts: [],
      createdAt: editingPendingTask.createdAt,
      updatedAt: editingPendingTask.createdAt,
    };
  }, [editingPendingTask]);

  const selectedProject =
    projectsForEnvironment.find(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    ) ??
    // While editing a queued task whose project shell is absent, keep the task
    // pinned to its own project — falling through to an arbitrary first
    // project would silently retarget it (and its reused turn identifiers).
    (editingPendingProject !== null &&
    selectedProjectKey ===
      scopedProjectKey(editingPendingProject.environmentId, editingPendingProject.id)
      ? editingPendingProject
      : (projectsForEnvironment[0] ?? null));

  const selectedEnvironmentServerConfig = useEnvironmentServerConfig(
    selectedProject?.environmentId ?? null,
  );
  const isScratchDraft =
    selectedProject !== null &&
    isScratchProject(selectedProject, selectedEnvironmentServerConfig?.scratchWorkspaceRoot);
  const serverConfigs = useServerConfigs();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  // A thread without a project can move to any connected machine that offers
  // one; its Scratch project there is created on the switch if it is missing.
  const scratchEnvironments = useMemo(
    () =>
      connectedEnvironments.filter(
        (environment) =>
          availableScratchWorkspaceRoot(
            environment.connectionState,
            serverConfigs.get(environment.environmentId),
          ) !== null,
      ),
    [connectedEnvironments, serverConfigs],
  );

  // Only offer machines that host a project with the same folder name or title,
  // so switching computers moves the same project instead of jumping to whatever
  // unrelated project happens to be first on the other machine.
  // `|| null` (not `??`): a pending-task placeholder project can have an empty
  // workspaceRoot, and an "" basename would reject every real host below.
  const selectedWorkspaceBasename = selectedProject?.workspaceRoot.split("/").at(-1) || null;
  const selectedProjectTitle = selectedProject?.title ?? null;
  const environments = useMemo(() => {
    if (isScratchDraft) {
      return scratchEnvironments.map((environment) => ({
        environmentId: environment.environmentId,
        environmentLabel: environment.environmentLabel,
      }));
    }
    const seen = new Set<EnvironmentId>();
    const result: Array<{
      readonly environmentId: EnvironmentId;
      readonly environmentLabel: string;
    }> = [];
    const hostsSelectedProject = (project: EnvironmentProject) => {
      if (selectedWorkspaceBasename === null) {
        return true;
      }
      return (
        project.workspaceRoot.split("/").at(-1) === selectedWorkspaceBasename ||
        (selectedProjectTitle !== null && project.title === selectedProjectTitle)
      );
    };
    for (const project of projects) {
      if (!hostsSelectedProject(project)) {
        continue;
      }
      if (seen.has(project.environmentId)) {
        continue;
      }
      const environment = savedConnectionsById[project.environmentId];
      if (!environment) {
        continue;
      }
      seen.add(project.environmentId);
      result.push({
        environmentId: project.environmentId,
        environmentLabel: environment.environmentLabel,
      });
    }
    return result;
  }, [
    isScratchDraft,
    projects,
    savedConnectionsById,
    scratchEnvironments,
    selectedWorkspaceBasename,
    selectedProjectTitle,
  ]);

  // While a queued pending task is being edited its draft lives under a key
  // scoped to the queued message, so new-task drafts stay intact.
  const selectedProjectDraftKey = editingPendingTask
    ? pendingTaskDraftKey(editingPendingTask.messageId)
    : selectedProject
      ? activeDraftKey
      : null;
  // selectedProject can resolve without setProject ever running (the
  // environment's first project is the fallback, and the draft screen skips
  // setProject when the route's project already matches it). The composer
  // still needs a draft to write into, so bind one the moment a project is
  // in view and nothing else owns the key.
  useEffect(() => {
    if (activeDraftKey !== null || editingPendingTask !== null || selectedProject === null) {
      return;
    }
    setActiveDraftKey(
      createNewTaskDraft({
        environmentId: selectedProject.environmentId,
        projectId: selectedProject.id,
      }),
    );
  }, [activeDraftKey, editingPendingTask, selectedProject]);
  const selectedProjectDraft = useComposerDraft(selectedProjectDraftKey);
  const prompt = selectedProjectDraft.text;
  const attachments = selectedProjectDraft.attachments;
  const projectSettings = useMemo(
    () =>
      resolveProjectSettings(
        selectedEnvironmentServerConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
        selectedProject?.id ?? null,
        selectedProject,
      ),
    [selectedEnvironmentServerConfig?.settings, selectedProject],
  );
  const defaultRuntimeMode = editingPendingTask
    ? (editingPendingTask.runtimeMode ?? DEFAULT_RUNTIME_MODE)
    : projectSettings.settings.defaultRuntimeMode;
  const runtimeMode = selectedProjectDraft.runtimeMode ?? defaultRuntimeMode;

  // Antigravity keeps unavailable selections so sign-out or a catalog change
  // cannot switch the user's model. Other providers retain their fallback
  // rules. Implicit defaults also exclude legacy models for those providers.
  const draftModelSelection = resolveSelectableModelSelection(
    selectedEnvironmentServerConfig,
    selectedProjectDraft.modelSelection ?? null,
    selectedProject?.id ?? null,
  );
  const projectDefaultModelSelection = resolveDefaultableModelSelection(
    selectedEnvironmentServerConfig,
    projectSettings.settings.defaultModelSelection,
    selectedProject?.id ?? null,
  );
  const storedStickyModelSelection = useStickyComposerModelSelection();
  const stickyModelSelection = resolveDefaultableModelSelection(
    selectedEnvironmentServerConfig,
    storedStickyModelSelection,
    selectedProject?.id ?? null,
  );
  const modelOptions = useMemo(
    () =>
      buildModelOptions(
        selectedEnvironmentServerConfig,
        draftModelSelection ?? projectDefaultModelSelection ?? stickyModelSelection,
        undefined,
        selectedProject?.id ?? null,
      ),
    [
      selectedEnvironmentServerConfig,
      draftModelSelection,
      projectDefaultModelSelection,
      stickyModelSelection,
      selectedProject?.id,
    ],
  );

  // An unsent draft keeps its explicit pick. Fresh drafts resolve the project
  // default before the last manual app-wide selection and provider default.
  const selectedModel = resolveNewTaskModelSelection({
    draftSelection: draftModelSelection,
    projectDefaultSelection: projectDefaultModelSelection,
    stickySelection: stickyModelSelection,
    modelOptions,
  });
  const selectedModelKey = selectedModel
    ? `${selectedModel.instanceId}:${selectedModel.model}`
    : null;

  const selectedModelOption =
    modelOptions.find(
      (option) =>
        selectedModel &&
        option.selection.instanceId === selectedModel.instanceId &&
        option.selection.model === selectedModel.model,
    ) ?? null;
  const selectedProviderStatus = useMemo(
    () =>
      selectedEnvironmentServerConfig?.providers.find(
        (provider) => provider.instanceId === selectedModel?.instanceId,
      ) ?? null,
    [selectedEnvironmentServerConfig, selectedModel?.instanceId],
  );
  const planModeEnabled =
    legacyPlanModeEnabled && selectedProviderStatus?.showInteractionModeToggle !== false;
  const interactionMode = planModeEnabled
    ? (selectedProjectDraft.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE)
    : DEFAULT_PROVIDER_INTERACTION_MODE;
  const setSelectedModelKey = useCallback(
    // Options ride along in the same write: a follow-up setSelectedModelOptions
    // call would rebuild the selection from the stale pre-switch model.
    (key: string | null, options?: ReadonlyArray<ProviderOptionSelection>) => {
      if (!key || !selectedProjectDraftKey) {
        return;
      }
      const option = modelOptions.find((candidate) => candidate.key === key);
      if (!option) {
        return;
      }
      const selection = withRememberedModelOptions(
        options ? { ...option.selection, options } : option.selection,
      );
      const provider = selectedEnvironmentServerConfig?.providers.find(
        (candidate) => candidate.instanceId === selection.instanceId,
      );
      updateComposerDraftSettings(selectedProjectDraftKey, {
        modelSelection: selection,
        ...(provider?.showInteractionModeToggle === false
          ? { interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE }
          : {}),
      });
      setStickyComposerModelSelection(selection);
    },
    [modelOptions, selectedEnvironmentServerConfig, selectedProjectDraftKey],
  );
  const setSelectedModelOptions = useCallback(
    (options: ReadonlyArray<ProviderOptionSelection> | undefined) => {
      if (!selectedModel || !selectedProjectDraftKey) {
        return;
      }
      rememberModelOptions(selectedModel.instanceId, selectedModel.model, options ?? []);
      const nextSelection: ModelSelection = options
        ? { ...selectedModel, options }
        : {
            instanceId: selectedModel.instanceId,
            model: selectedModel.model,
          };
      updateComposerDraftSettings(selectedProjectDraftKey, {
        modelSelection: nextSelection,
      });
      setStickyComposerModelSelection(nextSelection);
    },
    [selectedModel, selectedProjectDraftKey],
  );

  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  const setPrompt = useCallback(
    (value: string) => {
      if (!selectedProjectDraftKey) {
        return;
      }
      setComposerDraftText(selectedProjectDraftKey, value);
    },
    [selectedProjectDraftKey],
  );
  const replaceAttachments = useCallback(
    (nextAttachments: ReadonlyArray<DraftComposerAttachment>) => {
      if (!selectedProjectDraftKey) {
        return;
      }
      replaceComposerDraftAttachments(selectedProjectDraftKey, nextAttachments);
    },
    [selectedProjectDraftKey],
  );
  // Returns how many attachments the live cap rejected so the caller can
  // tell the user (a concurrent add can fill the draft mid-pick).
  const appendAttachments = useCallback(
    (
      nextAttachments: ReadonlyArray<DraftComposerAttachment>,
      insertion?: ComposerDraftInsertion,
    ): number => {
      if (!selectedProjectDraftKey) {
        return 0;
      }
      return appendComposerDraftAttachments(selectedProjectDraftKey, nextAttachments, {
        appendReference: true,
        insertion,
      });
    },
    [selectedProjectDraftKey],
  );
  const removeAttachment = useCallback(
    (imageId: string) => {
      if (!selectedProjectDraftKey) {
        return;
      }
      removeComposerDraftAttachment(selectedProjectDraftKey, imageId);
    },
    [selectedProjectDraftKey],
  );
  const clearAttachments = useCallback(() => {
    if (!selectedProjectDraftKey) {
      return;
    }
    replaceComposerDraftAttachments(selectedProjectDraftKey, []);
  }, [selectedProjectDraftKey]);
  // The composer's draft follows the project it will be sent to: switching
  // mid-compose keeps the same draft and moves it, so typed text follows the
  // user. A pending-task edit owns its own key and is untouched here.
  const carryDraftContentTo = useCallback(
    (project: EnvironmentProject) => {
      const target = { environmentId: project.environmentId, projectId: project.id };
      if (activeDraftKey !== null && isNewTaskDraftKey(activeDraftKey)) {
        retargetNewTaskDraft(activeDraftKey, target);
      } else if (!editingPendingTaskRef.current) {
        setActiveDraftKey(createNewTaskDraft(target));
      }
    },
    [activeDraftKey],
  );

  const setProject = useCallback(
    (project: EnvironmentProject) => {
      carryDraftContentTo(project);
      setSelectedEnvironmentId(project.environmentId);
      setSelectedProjectKey(scopedProjectKey(project.environmentId, project.id));
    },
    [carryDraftContentTo],
  );

  const openDraft = useCallback(
    (draftKey: string): boolean => {
      const draft = appAtomRegistry.get(composerDraftsAtom)[draftKey];
      const stamp = draft?.project;
      if (!isNewTaskDraftKey(draftKey) || !stamp) {
        return false;
      }
      // The stamped project must be loaded: selectedProject falls back to
      // the environment's first project otherwise, and the draft would be
      // sent somewhere the user never chose.
      const projectLoaded = projects.some(
        (project) =>
          project.environmentId === stamp.environmentId && project.id === stamp.projectId,
      );
      if (!projectLoaded) {
        return false;
      }
      setActiveDraftKey(draftKey);
      setSelectedEnvironmentId(stamp.environmentId);
      setSelectedProjectKey(scopedProjectKey(stamp.environmentId, stamp.projectId));
      return true;
    },
    [projects],
  );

  const selectEnvironment = useCallback(
    (environmentId: EnvironmentId) => {
      const match = resolveEnvironmentProjectMatch(
        projects.filter((project) => project.environmentId === environmentId),
        selectedProject,
      );
      if (match) {
        carryDraftContentTo(match);
      }
      setSelectedEnvironmentId(environmentId);
      setSelectedProjectKey(match ? scopedProjectKey(match.environmentId, match.id) : null);
    },
    [projects, selectedProject, carryDraftContentTo],
  );

  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const [switchingToEnvironmentId, setSwitchingToEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  // The latest switch wins: a slower, earlier one must not retarget the draft.
  const latestSwitchRef = useRef<object | null>(null);
  const switchEnvironment = useCallback(
    async (environmentId: EnvironmentId): Promise<boolean> => {
      if (environmentId === selectedEnvironmentId) {
        latestSwitchRef.current = null;
        setSwitchingToEnvironmentId(null);
        return true;
      }
      if (!isScratchDraft) {
        selectEnvironment(environmentId);
        return true;
      }
      const request = {};
      latestSwitchRef.current = request;
      setSwitchingToEnvironmentId(environmentId);
      try {
        const result = await openScratch({ environmentId, input: {} });
        if (latestSwitchRef.current !== request) return false;
        if (result._tag === "Success") {
          setProject(result.value);
          return true;
        }
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            "Could not switch machine",
            error instanceof Error
              ? error.message
              : "The folder for threads without a project could not be created.",
          );
        }
        return false;
      } finally {
        if (latestSwitchRef.current === request) {
          latestSwitchRef.current = null;
          setSwitchingToEnvironmentId(null);
        }
      }
    },
    [isScratchDraft, openScratch, selectEnvironment, selectedEnvironmentId, setProject],
  );

  const setRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (selectedProjectDraftKey) {
        updateComposerDraftSettings(selectedProjectDraftKey, { runtimeMode: value });
      }
    },
    [selectedProjectDraftKey],
  );
  const setInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (selectedProjectDraftKey) {
        updateComposerDraftSettings(selectedProjectDraftKey, {
          interactionMode: resolveProviderInteractionMode(selectedProviderStatus, value),
        });
      }
    },
    [selectedProjectDraftKey, selectedProviderStatus],
  );

  const beginEditingPendingTask = useCallback((messageId: string): boolean => {
    const message = findQueuedPendingTask(messageId);
    if (!message?.creation) {
      return false;
    }
    const draftKey = pendingTaskDraftKey(message.messageId);
    // Only hydrate a fresh editing draft; reopening mid-edit keeps newer edits.
    if (isComposerDraftEmpty(getComposerDraftSnapshot(draftKey))) {
      setComposerDraftText(draftKey, message.text);
      setComposerDraftContext(draftKey, message.context);
      replaceComposerDraftAttachments(draftKey, message.attachments);
      updateComposerDraftSettings(draftKey, {
        modelSelection: message.modelSelection,
        runtimeMode: message.runtimeMode,
        interactionMode: message.interactionMode,
      });
    }
    setSelectedEnvironmentId(message.environmentId);
    setSelectedProjectKey(scopedProjectKey(message.environmentId, message.creation.projectId));
    activeEditingMessageId = message.messageId;
    editingPendingTaskRef.current = message;
    editingRevisionRef.current = capturePendingTaskEditorWriteBaseline(message.messageId);
    setEditingPendingTask(message);
    // Hold the outbox drain off this task while it is open in the editor.
    holdEditingQueuedMessage(message.messageId);
    return true;
  }, []);

  const buildPendingTaskMessage = useCallback(
    (metadata: TurnCommandMetadata): QueuedThreadMessage | null => {
      if (!selectedProject || !selectedProjectDraftKey) {
        return null;
      }
      const draft = getComposerDraftSnapshot(selectedProjectDraftKey);
      const text = draft.text.trim();
      // Use the displayed selection rules without substituting an unavailable
      // Antigravity model while the task is queued.
      const draftModelSelection =
        resolveSelectableModelSelection(
          selectedEnvironmentServerConfig,
          draft.modelSelection ?? null,
          selectedProject.id,
        ) ?? selectedModel;
      // A shared image or file is a task on its own; text is optional.
      if ((text.length === 0 && draft.attachments.length === 0) || !draftModelSelection) {
        return null;
      }
      // When the selection is the stand-in built from the queued snapshot,
      // persist the original (possibly absent) snapshot values — the
      // stand-in's placeholder title/workspaceRoot must never be written back
      // as if they were real project metadata.
      const usingPendingSnapshot = selectedProject === editingPendingProject;
      const projectTitle = usingPendingSnapshot
        ? editingPendingTask?.creation?.projectTitle
        : selectedProject.title;
      const projectCwd = usingPendingSnapshot
        ? editingPendingTask?.creation?.projectCwd
        : selectedProject.workspaceRoot;
      return {
        environmentId: selectedProject.environmentId,
        threadId: ThreadId.make(metadata.threadId),
        messageId: MessageId.make(metadata.messageId),
        commandId: CommandId.make(metadata.commandId),
        text,
        attachments: draft.attachments,
        context: draft.context,
        modelSelection: draftModelSelection,
        runtimeMode: draft.runtimeMode ?? defaultRuntimeMode,
        interactionMode: resolvePendingTaskInteractionMode({
          preferenceLoaded: planModePreferenceLoaded,
          planModeEnabled: legacyPlanModeEnabled,
          draftInteractionMode: draft.interactionMode,
          queuedInteractionMode: editingPendingTask?.interactionMode,
          provider: selectedEnvironmentServerConfig?.providers.find(
            (candidate) => candidate.instanceId === draftModelSelection.instanceId,
          ),
        }),
        creation: {
          projectId: selectedProject.id,
          ...(projectTitle !== undefined ? { projectTitle } : {}),
          ...(projectCwd !== undefined ? { projectCwd } : {}),
        },
        createdAt: metadata.createdAt,
      };
    },
    [
      defaultRuntimeMode,
      editingPendingProject,
      editingPendingTask,
      selectedEnvironmentServerConfig,
      selectedModel,
      selectedProject,
      selectedProjectDraftKey,
      legacyPlanModeEnabled,
      planModePreferenceLoaded,
    ],
  );

  const finishEditingPendingTask = useCallback(() => {
    const editing = editingPendingTaskRef.current;
    editingPendingTaskRef.current = null;
    if (editing) {
      if (activeEditingMessageId === editing.messageId) {
        activeEditingMessageId = null;
      }
      clearComposerDraft(pendingTaskDraftKey(editing.messageId));
      releaseEditingQueuedMessage(editing.messageId);
      scheduleUnusedComposerAttachmentCleanup(editing.attachments);
    }
    setEditingPendingTask(null);
  }, []);

  // If the queued task disappears mid-edit (deleted from the list, or
  // delivered), end the editing session immediately without saving — a later
  // flush must not resurrect it, and the composer should fall back to the
  // regular per-project draft.
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  useEffect(() => {
    const editing = editingPendingTaskRef.current;
    if (!editing) {
      return;
    }
    const stillQueued = flattenQueuedThreadMessages(queuedMessagesByThreadKey).some(
      (candidate) => candidate.messageId === editing.messageId,
    );
    if (!stillQueued) {
      finishEditingPendingTask();
    }
  }, [finishEditingPendingTask, queuedMessagesByThreadKey]);

  // Leaving the flow mid-edit (sheet dismissed or draft screen popped) saves
  // the current edits back into the queued task so nothing typed here is lost.
  const editingFlushRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    editingFlushRef.current = () => {
      const editing = editingPendingTaskRef.current;
      if (!editing) {
        return;
      }
      editingPendingTaskRef.current = null;
      setEditingPendingTask(null);
      if (activeEditingMessageId === editing.messageId) {
        activeEditingMessageId = null;
      }

      const message = buildPendingTaskMessage({
        threadId: editing.threadId,
        commandId: editing.commandId,
        messageId: editing.messageId,
        createdAt: editing.createdAt,
      });

      if (!message) {
        // The edits are currently unsendable (e.g. the prompt was cleared).
        // Keep both the draft and the drain lock: the stale queued payload
        // must not auto-send content the user just removed, and reopening the
        // task resumes from the saved draft.
        return;
      }

      // The write handoff lets a reopened editor follow this editor's pending
      // save. Its CAS still rejects unrelated queue edits, deletes, and
      // deliveries, so the flush cannot resurrect or overwrite them.
      void flushPendingTaskEditorWrite({
        message,
        baseline: editingRevisionRef.current,
        draftKey: pendingTaskDraftKey(editing.messageId),
      })
        .then((savedDraftStillCurrent) => {
          // If this task was reopened (possibly in a fresh provider) while
          // the save was in flight, that session owns the draft and the lock.
          if (activeEditingMessageId === editing.messageId) {
            return;
          }
          if (!savedDraftStillCurrent) {
            // A newer queue write won the CAS, or a newer editor changed this
            // draft. Keep the draft and drain lock so reopening can retry it.
            return;
          }
          clearComposerDraft(pendingTaskDraftKey(editing.messageId));
          releaseEditingQueuedMessage(editing.messageId);
          scheduleUnusedComposerAttachmentCleanup(editing.attachments);
        })
        .catch((error) => {
          // Keep the drain lock and the draft: delivering the stale payload
          // would silently drop the newer edits. Reopening the task retries.
          console.warn("[new-task] failed to save edited pending task", error);
        });
    };
  }, [buildPendingTaskMessage]);
  const cancelEditingPendingTask = useCallback(() => {
    editingFlushRef.current?.();
  }, []);
  useEffect(
    () => () => {
      editingFlushRef.current?.();
    },
    [],
  );

  const value = useMemo<NewTaskFlowContextValue>(
    () => ({
      projectScopes,
      selectedEnvironmentId,
      selectedProjectKey,
      selectedModelKey,
      draftKey: selectedProjectDraftKey,
      editingPendingTask,
      prompt,
      attachments,
      submitting,
      runtimeMode,
      interactionMode,
      planModeEnabled,
      expandedProvider,
      environments,
      selectedProject,
      isScratchDraft,
      modelOptions,
      selectedModel,
      selectedModelOption,
      selectedProviderStatus,
      providerGroups,
      reset,
      setProject,
      openDraft,
      selectEnvironment,
      switchEnvironment,
      switchingToEnvironmentId,
      setSelectedModelKey,
      beginEditingPendingTask,
      finishEditingPendingTask,
      cancelEditingPendingTask,
      buildPendingTaskMessage,
      setPrompt,
      replaceAttachments,
      appendAttachments,
      removeAttachment,
      clearAttachments,
      setSubmitting,
      setRuntimeMode,
      setInteractionMode,
      setSelectedModelOptions,
      setExpandedProvider,
    }),
    [
      attachments,
      beginEditingPendingTask,
      buildPendingTaskMessage,
      cancelEditingPendingTask,
      editingPendingTask,
      environments,
      expandedProvider,
      finishEditingPendingTask,
      interactionMode,
      isScratchDraft,
      planModeEnabled,
      projectScopes,
      modelOptions,
      prompt,
      providerGroups,
      replaceAttachments,
      reset,
      runtimeMode,
      selectedEnvironmentId,
      selectedModel,
      selectedModelKey,
      selectedModelOption,
      selectedProjectDraftKey,
      selectedProviderStatus,
      setSelectedModelOptions,
      selectedProject,
      selectedProjectKey,
      setProject,
      openDraft,
      selectEnvironment,
      switchEnvironment,
      switchingToEnvironmentId,
      setInteractionMode,
      setPrompt,
      setRuntimeMode,
      setSelectedModelKey,
      submitting,
      appendAttachments,
      clearAttachments,
      removeAttachment,
    ],
  );

  return <NewTaskFlowContext.Provider value={value}>{props.children}</NewTaskFlowContext.Provider>;
}

export function useNewTaskFlow() {
  const value = React.use(NewTaskFlowContext);
  if (value === null) {
    throw new Error("useNewTaskFlow must be used within NewTaskFlowProvider.");
  }
  return value;
}
