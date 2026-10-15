"use client";

import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { resolveThreadReferenceCopyTarget } from "@t3tools/shared/threadReference";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ProjectId } from "@t3tools/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  FileSearchIcon,
  LinkIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  RotateCcwIcon,
  SettingsIcon,
  SquarePenIcon,
  SunIcon,
  TextSearchIcon,
  BotIcon,
} from "lucide-react";
import { requestThreadFindOpen } from "./chat/threadFindActionBus";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";

import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useBotsByRecentUse, useStartBotChat } from "../hooks/useBotChat";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { composerPromptLink, copyPromptLink } from "./promptLinks/copyPromptLink";
import { useClientSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { useCustomThemes } from "../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../hooks/useEnvironmentTheme";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import { getThemeDefinition } from "../themePalette";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  ThemePreviewCircle,
} from "./settings/ThemePreviewCircles";
import { serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { requestNewBot } from "./NewBotDialog";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useThreadShells } from "../state/entities";
import { useThreadSearch } from "../state/queries";
import { resolveThreadActionProjectRef } from "../lib/chatThreadActions";
import { onOpenCommandPalette } from "../commandPaletteBus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { getLatestThreadForProject, sortThreads } from "../lib/threadSort";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { useAvailableSettingsSearchItems } from "./settings/useAvailableSettingsSearchItems";
import {
  ADDON_ICON_CLASS,
  buildProjectActionItems,
  buildRootGroups,
  buildThreadActionItems,
  buildCommandPaletteRows,
  enumerateCommandPaletteItems,
  findHighlightedCommandPaletteItem,
  type CommandPaletteActionItem,
  type CommandPaletteOpenIntent,
  type CommandPaletteProject,
  type CommandPaletteSubmenuItem,
  type CommandPaletteView,
  filterCommandPaletteGroups,
  getCommandPaletteInputPlaceholder,
  ITEM_ICON_CLASS,
  RECENT_THREAD_LIMIT,
  reduceCommandPaletteUiState,
  type SearchOverlayMode,
} from "./CommandPalette.logic";
import { orderItemsByPreferredIds, sortLogicalProjectsForSidebar } from "./Sidebar.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import {
  CommandPaletteVirtualizedResults,
  scrollCommandPaletteRowIntoView,
} from "./CommandPaletteResults";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProjectFilePicker } from "./files/ProjectFilePicker";
import { toggleThemeEditorForTheme } from "./settings/themeEditorStore";
import { searchSettings, SETTINGS_SECTION_LABELS } from "./settings/settingsSearch";
import { ThreadCommandSubtitle } from "./ThreadCommandSubtitle";
import { ThreadRowLeadingStatus, ThreadRowTrailingStatus } from "./ThreadStatusIndicators";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../state/server";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { resolveShortcutCommand, threadJumpIndexFromCommand } from "../keybindings";
import { CommandDialog, CommandDialogPopup } from "./ui/command";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { ComposerHandleContext, useComposerHandleContext } from "../composerHandleContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { getProjectOrderKey } from "../logicalProject";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "../sidebarProjectGrouping";
import type { Project } from "../types";

function projectFaviconIcon(project: Project): ReactNode {
  return <ProjectFavicon project={project} className={ITEM_ICON_CLASS} />;
}

function botRole(project: CommandPaletteProject): string | undefined {
  return project.bot?.role || undefined;
}

const OVERLAY_MODE_BY_COMMAND = {
  "commandPalette.toggle": "command",
  "filePicker.toggle": "files",
} as const satisfies Partial<Record<string, SearchOverlayMode>>;

function overlayModeForCommand(command: string | null): SearchOverlayMode | null {
  if (command === null) return null;
  return command in OVERLAY_MODE_BY_COMMAND
    ? OVERLAY_MODE_BY_COMMAND[command as keyof typeof OVERLAY_MODE_BY_COMMAND]
    : null;
}

const APPEARANCE_OPTIONS = [
  { mode: "system", label: "System", icon: MonitorIcon },
  { mode: "light", label: "Light", icon: SunIcon },
  { mode: "dark", label: "Dark", icon: MoonIcon },
] as const;

function notifyThemeSaveFailure(): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Couldn't save theme selection",
      description: "Try again.",
    }),
  );
}

export function CommandPalette({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(reduceCommandPaletteUiState, {
    open: false,
    mode: "command",
    openIntent: null,
  });
  const setOpen = useCallback((open: boolean) => dispatch({ _tag: "SetOpen", open }), []);
  const toggleMode = useCallback(
    (mode: SearchOverlayMode) => dispatch({ _tag: "ToggleMode", mode }),
    [],
  );
  const clearOpenIntent = useCallback(() => dispatch({ _tag: "ClearOpenIntent" }), []);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { theme, themeHalves, resolvedTheme, appearanceMode, setAppearanceMode } = useTheme();
  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const previewOpen = useRightPanelStore((state) =>
    routeThreadRef
      ? selectActiveRightPanel(state.byThreadKey, routeThreadRef) === "preview"
      : false,
  );

  useEffect(() => {
    if (!state.open || state.mode === "command") return;
    const onEscapeKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      toggleMode("command");
    };
    window.addEventListener("keydown", onEscapeKeyDown, true);
    return () => window.removeEventListener("keydown", onEscapeKeyDown, true);
  }, [state.mode, state.open, toggleMode]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Resolve with the complete shortcut context so customized bindings
      // using any documented `when` condition (e.g. previewFocus) work.
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          modelPickerOpen: composerHandleRef.current?.isModelPickerOpen() ?? false,
        },
      });
      if (command === "appearance.cycle") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        const nextMode =
          appearanceMode === "system" ? "light" : appearanceMode === "light" ? "dark" : "system";
        if (!setAppearanceMode(nextMode)) {
          notifyThemeSaveFailure();
        } else {
          toastManager.add({
            id: "appearance-cycle",
            title: `Appearance: ${APPEARANCE_OPTIONS.find((option) => option.mode === nextMode)?.label}`,
            timeout: 1500,
          });
        }
        return;
      }
      if (command === "theme.select") {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        dispatch({ _tag: "OpenChangeTheme" });
        return;
      }
      if (command === "themeEditor.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleThemeEditorForTheme({
          theme,
          themeHalves,
          initialAppearance: resolvedTheme,
        });
        return;
      }
      if (command === "usage.open") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        void navigate({ to: "/usage" });
        return;
      }
      const mode = overlayModeForCommand(command);
      if (mode === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleMode(mode);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    appearanceMode,
    keybindings,
    navigate,
    previewOpen,
    resolvedTheme,
    setAppearanceMode,
    setOpen,
    terminalOpen,
    theme,
    themeHalves,
    toggleMode,
  ]);

  useEffect(
    () =>
      onOpenCommandPalette((detail) => {
        if (detail.query !== undefined) {
          dispatch({ _tag: "OpenSearch", query: detail.query });
        } else {
          setOpen(true);
        }
      }),
    [setOpen],
  );

  return (
    <ComposerHandleContext value={composerHandleRef}>
      <CommandDialog
        open={state.open}
        onOpenChange={(open, eventDetails) => {
          if (!open && eventDetails.reason === "escape-key" && state.mode !== "command") {
            eventDetails.cancel();
            toggleMode("command");
            return;
          }
          setOpen(open);
        }}
      >
        {/* Block background focus calls for the entire time the palette is open. */}
        <div className="contents" inert={state.open}>
          {children}
        </div>
        <CommandPaletteDialog
          mode={state.mode}
          openIntent={state.openIntent}
          setOpen={setOpen}
          openOverlayMode={toggleMode}
          clearOpenIntent={clearOpenIntent}
        />
      </CommandDialog>
    </ComposerHandleContext>
  );
}

function CommandPaletteDialog(props: {
  readonly mode: SearchOverlayMode;
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openOverlayMode: (mode: SearchOverlayMode) => void;
  readonly clearOpenIntent: () => void;
}) {
  const composerHandleRef = useComposerHandleContext();

  return (
    <CommandDialogPopup
      aria-label={props.mode === "files" ? "File picker" : "Command palette"}
      className="overflow-hidden"
      data-command-palette="true"
      data-palette-mode={props.mode}
      data-testid="command-palette"
      finalFocus={() => {
        composerHandleRef?.current?.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => {
        props.setOpen(false);
      }}
    >
      {props.mode === "files" ? (
        <ProjectFilePicker setOpen={props.setOpen} />
      ) : (
        <OpenCommandPaletteDialog
          openIntent={props.openIntent}
          setOpen={props.setOpen}
          openOverlayMode={props.openOverlayMode}
          clearOpenIntent={props.clearOpenIntent}
        />
      )}
    </CommandDialogPopup>
  );
}

function OpenCommandPaletteDialog(props: {
  readonly openIntent: CommandPaletteOpenIntent | null;
  readonly setOpen: (open: boolean) => void;
  readonly openOverlayMode: (mode: SearchOverlayMode) => void;
  readonly clearOpenIntent: () => void;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { clearOpenIntent, openIntent, openOverlayMode, setOpen } = props;
  const [query, setQuery] = useState(openIntent?.kind === "search" ? openIntent.query : "");
  const deferredQuery = useDeferredValue(query);
  const isActionsOnly = deferredQuery.startsWith(">");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const resultListRef = useRef<LegendListRef | null>(null);
  // Typing or entering a submenu clears the highlight. Base UI keeps its own on the
  // first row, but the palette shows none until the user navigates, and the first
  // ArrowDown lands on it.
  const highlightClearedRef = useRef(false);
  function clearTypedHighlight(): void {
    highlightClearedRef.current = true;
    setHighlightedItemValue(null);
  }
  const clientSettings = useClientSettings();
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, {
    reportFailure: false,
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const availableSettingsSearchItems = useAvailableSettingsSearchItems();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const paletteRouteTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const projects = useProjects();
  const activeThreadReferenceCopyTarget = activeThread
    ? resolveThreadReferenceCopyTarget({ threadId: activeThread.id })
    : null;
  const copyActiveThreadReference = useCallback(async () => {
    const target = activeThreadReferenceCopyTarget;
    if (target === null) return;
    try {
      const didCopy = await writeTextToClipboard(target.value, target.clipboardTarget);
      if (!didCopy) return;
      toastManager.add({
        type: "success",
        title: target.successTitle,
        description: target.value,
      });
    } catch (error) {
      console.error(error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: target.failureTitle,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [activeThreadReferenceCopyTarget]);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const threads = useThreadShells();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const {
    theme,
    themeHalves,
    resolvedTheme,
    appearanceMode,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
  } = useTheme();
  const customThemes = useCustomThemes();
  const environmentThemes = useEnvironmentThemeDefinitions();
  const themeCards = useMemo(() => {
    const seen = new Set<string>();
    return [
      ...STANDARD_THEME_CARDS.map((card) => ({ ...card, id: null })),
      ...[...BUILT_IN_THEMES, ...customThemes, ...environmentThemes]
        .filter((definition) => {
          if (seen.has(definition.id)) return false;
          seen.add(definition.id);
          return true;
        })
        .map(getThemeCardDefinition),
    ];
  }, [customThemes, environmentThemes]);
  const providers = useAtomValue(primaryServerProvidersAtom);
  const providerEntryByEnvironmentAndInstanceId = useMemo(() => {
    const map = new Map<string, ProviderInstanceEntry>();
    for (const environment of environments) {
      const serverConfig = environment.serverConfig;
      const environmentProviders =
        serverConfig?.providers ??
        (environment.environmentId === primaryEnvironmentId ? providers : []);
      const derived = deriveProviderInstanceEntries(environmentProviders);
      // Settings fill the ACP registry identity (agent id, icon URL) the
      // derived entries alone do not carry. This map is keyed by environment,
      // not project, because it backs thread rows across every project on
      // that environment; `enabled` stays machine-scoped (`null`) since no
      // single project applies.
      const entries = serverConfig
        ? applyProviderInstanceSettings(derived, serverConfig.settings, null)
        : derived;
      for (const entry of entries) {
        map.set(`${environment.environmentId}:${entry.instanceId}`, entry);
      }
    }
    return map;
  }, [environments, primaryEnvironmentId, providers]);
  const [viewStack, setViewStack] = useState<CommandPaletteView[]>([]);
  const currentView = viewStack.at(-1) ?? null;
  const environmentIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );
  const threadSearchQuery = currentView === null && !isActionsOnly ? deferredQuery : "";
  const threadSearch = useThreadSearch(environmentIds, threadSearchQuery);
  const threadContentMatchByKey = useMemo(
    () =>
      new Map(
        threadSearch.matches.flatMap((match) =>
          match.source === "user" || match.source === "assistant"
            ? [[threadSearchMatchKey(match), match] as const]
            : [],
        ),
      ),
    [threadSearch.matches],
  );
  const startBotChat = useStartBotChat();
  const recentBots = useBotsByRecentUse();

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const environmentLocationLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => {
          const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
          const isLocal = isPrimary || isDesktopLocalConnectionTarget(environment.entry.target);
          return [
            environment.environmentId,
            isPrimary ? "Local" : isLocal ? `${environment.label} (Local)` : environment.label,
          ] as const;
        }),
      ),
    [environments],
  );
  const bots = useMemo(() => projects.filter((project) => project.bot != null), [projects]);

  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: bots,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, bots],
  );
  const unsortedProjectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: clientSettings.sidebarProjectSortOrder === "manual" ? orderedProjects : bots,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [
      clientSettings.sidebarProjectSortOrder,
      environmentLabelById,
      orderedProjects,
      primaryEnvironmentId,
      bots,
    ],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        unsortedProjectGroups,
        threads,
        clientSettings.sidebarProjectSortOrder,
      ),
    [clientSettings.sidebarProjectSortOrder, threads, unsortedProjectGroups],
  );
  const contextualProjectRef = useMemo(
    () =>
      resolveThreadActionProjectRef({
        activeDraftThread,
        activeThread: activeThread ?? undefined,
        defaultProjectRef,
        handleNewThread,
      }),
    [activeDraftThread, activeThread, defaultProjectRef, handleNewThread],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: contextualProjectRef,
      }),
    [contextualProjectRef, projectGroups],
  );
  const pickerProjects = useMemo(
    () =>
      projectPickerEntries.map(({ group, targetProject }) => ({
        ...targetProject,
        displayName: group.displayName,
      })),
    [projectPickerEntries],
  );
  const projectGroupByTargetKey = useMemo(
    () =>
      new Map(
        projectPickerEntries.map(({ group, targetProject }) => [
          `${targetProject.environmentId}:${targetProject.id}`,
          group,
        ]),
      ),
    [projectPickerEntries],
  );

  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const projectTitleById = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.title])),
    [projects],
  );

  const activeThreadId = activeThread?.id;
  const supportsThreadFind =
    environments.find((environment) => environment.environmentId === activeThread?.environmentId)
      ?.serverConfig?.threadFind === true;

  const openProjectFromSearch = useMemo(
    () => async (project: (typeof projects)[number]) => {
      const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
      const groupedProjectKeys = group
        ? new Set(
            group.memberProjectRefs.map(
              (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
            ),
          )
        : null;
      const latestThread = groupedProjectKeys
        ? (sortThreads(
            threads.filter(
              (thread) =>
                thread.archivedAt === null &&
                groupedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
            ),
            clientSettings.sidebarThreadSortOrder,
          )[0] ?? null)
        : getLatestThreadForProject(
            threads.filter((thread) => thread.environmentId === project.environmentId),
            project.id,
            clientSettings.sidebarThreadSortOrder,
          );
      if (latestThread) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(latestThread.environmentId, latestThread.id),
          ),
        });
        return;
      }

      await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    },
    [
      clientSettings.sidebarThreadSortOrder,
      handleNewThread,
      navigate,
      projectGroupByTargetKey,
      threads,
    ],
  );

  const botSearchItems = useMemo(
    () =>
      buildProjectActionItems({
        projects: pickerProjects,
        valuePrefix: "project",
        searchTerms: (project) => [botRole(project) ?? ""],
        renderDescription: botRole,
        icon: projectFaviconIcon,
        runProject: openProjectFromSearch,
      }),
    [openProjectFromSearch, pickerProjects],
  );

  // Lists the current bot first, so Enter starts a chat with it.
  const botChatItems = useMemo(
    () =>
      enumerateCommandPaletteItems(
        buildProjectActionItems({
          projects: pickerProjects,
          valuePrefix: "new-thread-in",
          searchTerms: (project) => [botRole(project) ?? ""],
          renderDescription: botRole,
          icon: projectFaviconIcon,
          runProject: async (project) => {
            const group = projectGroupByTargetKey.get(`${project.environmentId}:${project.id}`);
            const contextualRefBelongsToGroup =
              contextualProjectRef !== null &&
              group?.memberProjectRefs.some(
                (projectRef) =>
                  projectRef.environmentId === contextualProjectRef.environmentId &&
                  projectRef.projectId === contextualProjectRef.projectId,
              );
            await startBotChat(
              contextualRefBelongsToGroup
                ? contextualProjectRef
                : scopeProjectRef(project.environmentId, project.id),
            );
          },
        }),
      ),
    [contextualProjectRef, pickerProjects, projectGroupByTargetKey, startBotChat],
  );

  const allThreadItems = useMemo(
    () =>
      buildThreadActionItems({
        threads,
        ...(activeThreadId ? { activeThreadId } : {}),
        projectTitleById,
        sortOrder: clientSettings.sidebarThreadSortOrder,
        icon: <MessageSquareIcon className={ITEM_ICON_CLASS} />,
        renderLeadingContent: (thread) => <ThreadRowLeadingStatus thread={thread} />,
        renderTrailingContent: (thread) => <ThreadRowTrailingStatus thread={thread} />,
        renderDescription: (thread, { projectTitle }) => {
          const modelInstanceId =
            thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
          const providerEntry =
            providerEntryByEnvironmentAndInstanceId.get(
              `${thread.environmentId}:${modelInstanceId}`,
            ) ?? null;
          return (
            <ThreadCommandSubtitle
              project={projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null}
              projectTitle={projectTitle ?? null}
              environmentLabel={environmentLocationLabelById.get(thread.environmentId) ?? "Remote"}
              isCurrent={thread.id === activeThreadId}
              driverKind={providerEntry?.driverKind ?? null}
              providerDisplayName={
                thread.runtime?.providerName ?? providerEntry?.displayName ?? modelInstanceId
              }
              acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
              acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl}
            />
          );
        },
        getContentMatch: (thread) => {
          const match = threadContentMatchByKey.get(
            threadSearchMatchKey({
              environmentId: thread.environmentId,
              threadId: thread.id,
            }),
          );
          return match && (match.source === "user" || match.source === "assistant")
            ? {
                source: match.source,
                snippet: match.snippet,
                query: threadSearch.query,
              }
            : undefined;
        },
        runThread: async (thread) => {
          await navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
          });
        },
      }),
    [
      activeThreadId,
      clientSettings.sidebarThreadSortOrder,
      navigate,
      projectByKey,
      environmentLocationLabelById,
      projectTitleById,
      providerEntryByEnvironmentAndInstanceId,
      threadContentMatchByKey,
      threadSearch.query,
      threads,
    ],
  );
  const recentThreadItems = allThreadItems.slice(0, RECENT_THREAD_LIMIT);

  const pushPaletteView = useCallback((view: CommandPaletteView): void => {
    setViewStack((previousViews) => [
      ...previousViews,
      {
        addonIcon: view.addonIcon,
        groups: view.groups,
        ...(view.initialQuery ? { initialQuery: view.initialQuery } : {}),
      },
    ]);
    highlightClearedRef.current = true;
    setHighlightedItemValue(null);
    setQuery(view.initialQuery ?? "");
  }, []);

  function pushView(item: CommandPaletteSubmenuItem): void {
    pushPaletteView({
      addonIcon: item.addonIcon,
      groups: item.groups,
      ...(item.initialQuery ? { initialQuery: item.initialQuery } : {}),
    });
  }

  function popView(): void {
    setViewStack((previousViews) => previousViews.slice(0, -1));
    setHighlightedItemValue(null);
    setQuery("");
  }

  function handleQueryChange(nextQuery: string): void {
    clearTypedHighlight();
    setQuery(nextQuery);
    if (nextQuery === "" && currentView?.initialQuery) {
      popView();
    }
  }

  useLayoutEffect(() => {
    if (openIntent?.kind !== "search") return;
    setViewStack([]);
    setQuery(openIntent.query);
    clearOpenIntent();
  }, [clearOpenIntent, openIntent]);

  const actionItems: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

  // The current bot, otherwise the most recently used one.
  const preferredBotEntry = projectPickerEntries.find((entry) => entry.isPreferred) ?? null;
  const newChatBot = preferredBotEntry
    ? { project: preferredBotEntry.targetProject, title: preferredBotEntry.group.displayName }
    : recentBots[0]
      ? { project: recentBots[0], title: recentBots[0].title }
      : null;
  if (newChatBot) {
    actionItems.push({
      kind: "action",
      value: "action:new-thread",
      searchTerms: ["new chat", "new thread", "bot", "create", "draft"],
      title: (
        <>
          New chat with <span className="font-semibold">{newChatBot.title}</span>
        </>
      ),
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.newLocal",
      run: async () => {
        await startBotChat(
          scopeProjectRef(newChatBot.project.environmentId, newChatBot.project.id),
        );
      },
    });

    actionItems.push({
      kind: "submenu",
      value: "action:new-thread-in",
      searchTerms: ["new chat", "new thread", "bot", "pick", "choose", "select"],
      title: "New chat with...",
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <SquarePenIcon className={ADDON_ICON_CLASS} />,
      groups: [{ value: "bots", label: "Bots", items: botChatItems }],
    });
  }

  if (activeThreadId && supportsThreadFind) {
    actionItems.push({
      kind: "action",
      value: "find-current-thread",
      title: "Find in current thread",
      searchTerms: ["find", "search", "messages", "plans"],
      icon: <TextSearchIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "chat.find",
      run: async () => {
        requestThreadFindOpen();
      },
    });
  }

  // Read once per open: the palette is a snapshot of the composer, not a live view of it.
  const promptLinkTarget = paletteRouteTarget
    ? paletteRouteTarget.kind === "server"
      ? paletteRouteTarget.threadRef
      : paletteRouteTarget.draftId
    : null;
  const promptLinkProjectRef = activeThread ?? activeDraftThread;
  const promptLinkInput =
    promptLinkTarget === null
      ? null
      : {
          target: promptLinkTarget,
          providers:
            environments.find(
              (environment) => environment.environmentId === promptLinkProjectRef?.environmentId,
            )?.serverConfig?.providers ?? [],
          threadModelSelection: activeThread?.modelSelection ?? null,
        };
  const plainPromptLink = promptLinkInput
    ? composerPromptLink({ ...promptLinkInput, withContext: false })
    : null;
  if (promptLinkInput !== null && plainPromptLink !== null) {
    actionItems.push({
      kind: "action",
      value: "action:copy-prompt-link",
      searchTerms: ["copy", "share", "prompt", "link"],
      title: "Copy prompt link",
      icon: <LinkIcon className={ITEM_ICON_CLASS} />,
      run: () => copyPromptLink(plainPromptLink),
    });
    const contextLink = composerPromptLink({ ...promptLinkInput, withContext: true });
    if (contextLink !== null && contextLink !== plainPromptLink) {
      actionItems.push({
        kind: "action",
        value: "action:copy-prompt-link-with-context",
        searchTerms: ["copy", "share", "prompt", "link", "model"],
        title: "Copy prompt link with model",
        icon: <LinkIcon className={ITEM_ICON_CLASS} />,
        run: () => copyPromptLink(contextLink),
      });
    }
  }

  if (activeThreadReferenceCopyTarget !== null) {
    actionItems.push({
      kind: "action",
      value: "action:copy-thread-reference",
      searchTerms: ["copy", "thread id", "reference"],
      title: "Copy thread ID",
      description: activeThreadReferenceCopyTarget.value,
      icon: <LinkIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "thread.copyReference",
      run: copyActiveThreadReference,
    });
  }

  if (activeThread !== null) {
    const thread = activeThread;
    actionItems.push({
      kind: "action",
      value: "action:restart-agent-session",
      searchTerms: ["restart", "reset", "reload", "agent", "session", "skills", "plugins", "mcp"],
      title: "Restart agent session",
      icon: <RotateCcwIcon className={ITEM_ICON_CLASS} />,
      // Stopping the provider process keeps the conversation: the next message
      // spawns a fresh one that resumes it and reloads skills, plugins, and MCP
      // servers. The fresh workspace scan updates the composer's slash menu.
      // Failures throw into executeItem's error toast.
      run: async () => {
        const { environmentId } = thread;
        if (thread.runtime !== null) {
          const stopped = await stopThreadSession({
            environmentId,
            input: { threadId: thread.id },
          });
          if (stopped._tag === "Failure") throw squashAtomCommandFailure(stopped);
        }
        // The server stops the process after accepting the command. A failed
        // stop shows in the thread.
        toastManager.add({
          type: "success",
          title: "Agent session will restart",
          description: "Your next message starts a fresh session.",
        });
        const project = projectByKey.get(`${environmentId}:${thread.projectId}`);
        if (!project) return;
        const refreshed = await refreshProviders({
          environmentId,
          input: {
            instanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
            cwd: project.workspaceRoot,
            fresh: true,
          },
        });
        if (refreshed._tag === "Failure") throw squashAtomCommandFailure(refreshed);
      },
    });
  }

  actionItems.push({
    kind: "action",
    value: "action:open-file-picker",
    searchTerms: ["go to file", "open file", "file picker", "find file", "quick open"],
    title: "Go to file",
    icon: <FileSearchIcon className={ITEM_ICON_CLASS} />,
    keepOpen: true,
    shortcutCommand: "filePicker.toggle",
    run: async () => {
      openOverlayMode("files");
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:new-bot",
    searchTerms: ["new bot", "create bot", "teammate", "assistant", "marketplace", "template"],
    title: "New bot",
    icon: <BotIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      requestNewBot();
    },
  });

  const changeThemeItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-theme",
    searchTerms: ["change theme", "appearance", "colors", "palette"],
    title: "Change theme",
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "theme.select",
    groups: [
      {
        value: "themes",
        label: "Change theme",
        items: themeCards.map(({ id, label, previews }) => ({
          kind: "action",
          value: id === null ? "theme:standard" : `theme:palette:${id}`,
          title: label,
          description: previews.length === 1 ? `For ${previews[0]!.mode} mode` : undefined,
          searchTerms: [label, "theme", "appearance"],
          icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
          titleTrailingContent: (
            <span className="flex shrink-0 items-center gap-2">
              {(themeHalves?.[resolvedTheme] ?? getThemeDefinition(theme)?.id ?? null) === id ? (
                <span className="text-xs text-muted-foreground/70">Current</span>
              ) : null}
              <span className="flex items-center gap-1" aria-hidden>
                {previews.map((preview) => (
                  <ThemePreviewCircle
                    key={preview.mode}
                    colors={preview.colors}
                    mode={preview.mode}
                    className="size-3 border-0"
                  />
                ))}
              </span>
            </span>
          ),
          run: async () => {
            const saved =
              previews.length === 1 && id !== null
                ? setThemeHalf(previews[0]!.mode, id)
                : setTheme(id ?? appearanceMode);
            if (!saved) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };
  actionItems.push(changeThemeItem);

  const changeAppearanceItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-appearance",
    searchTerms: ["change appearance", "light", "dark", "system", "mode", "toggle"],
    title: "Change appearance",
    icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <MonitorIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "appearance.cycle",
    groups: [
      {
        value: "appearance",
        label: "Change appearance",
        items: APPEARANCE_OPTIONS.map(({ mode, label, icon: Icon }) => ({
          kind: "action",
          value: `appearance:${mode}`,
          title: label,
          searchTerms: [label, "appearance", "mode"],
          icon: <Icon className={ITEM_ICON_CLASS} />,
          titleTrailingContent:
            appearanceMode === mode ? (
              <span className="text-xs text-muted-foreground/70">Current</span>
            ) : undefined,
          run: async () => {
            if (!setAppearanceMode(mode)) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };
  actionItems.push(changeAppearanceItem);

  useLayoutEffect(() => {
    if (openIntent?.kind !== "change-theme") return;
    clearOpenIntent();
    setViewStack([]);
    pushPaletteView({
      addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
      groups: [{ value: "themes", label: "Change theme", items: [] }],
    });
  }, [clearOpenIntent, openIntent, pushPaletteView]);

  actionItems.push({
    kind: "action",
    value: "action:theme-editor",
    searchTerms: ["theme", "appearance", "colors", "palette", "customize"],
    title: "Toggle theme editor",
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "themeEditor.toggle",
    run: async () => {
      toggleThemeEditorForTheme({
        theme,
        themeHalves,
        initialAppearance: resolvedTheme,
      });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:usage",
    searchTerms: ["usage", "use", "tokens", "cost", "spend", "limits", "stats", "analytics"],
    title: "Open usage",
    icon: <ChartNoAxesColumnIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "usage.open",
    run: async () => {
      await navigate({ to: "/usage" });
    },
  });

  actionItems.push({
    kind: "action",
    value: "action:settings",
    searchTerms: ["settings", "preferences", "configuration", "keybindings"],
    title: "Open settings",
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({ to: "/settings" });
    },
  });

  // Target the active thread or draft's bot, falling back to the first sidebar bot.
  const contextualBotGroup =
    (contextualProjectRef
      ? projectGroupByTargetKey.get(
          `${contextualProjectRef.environmentId}:${contextualProjectRef.projectId}`,
        )
      : null) ??
    projectGroups[0] ??
    null;
  if (contextualBotGroup) {
    actionItems.push({
      kind: "action",
      value: "action:project-settings",
      searchTerms: ["bot", "settings", "name", "icon", "instructions", "model", "remove"],
      title: "Bot settings",
      description: contextualBotGroup.displayName,
      icon: <BotIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await navigate({
          to: "/projects/$projectKey",
          params: { projectKey: contextualBotGroup.projectKey },
        });
      },
    });
  }

  const rootGroups = buildRootGroups({ actionItems, recentThreadItems });
  const settingsSearchItems: CommandPaletteActionItem[] = searchSettings(
    deferredQuery,
    availableSettingsSearchItems,
  ).map((item) => ({
    kind: "action",
    value: `setting:${item.id}`,
    searchTerms: [item.title, SETTINGS_SECTION_LABELS[item.to], ...(item.searchTerms ?? [])],
    title: item.title,
    description: `Settings · ${SETTINGS_SECTION_LABELS[item.to]}`,
    ...(item.secondary ? { secondary: true } : {}),
    icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      await navigate({
        to: item.to,
        hash: item.targetId ?? item.id,
        replace: pathname === item.to,
        hashScrollIntoView: false,
      });
    },
  }));
  const activeGroups =
    currentView?.groups[0]?.value === "themes"
      ? changeThemeItem.groups
      : currentView?.groups[0]?.value === "appearance"
        ? changeAppearanceItem.groups
        : (currentView?.groups ?? rootGroups);

  const displayedGroups = filterCommandPaletteGroups({
    activeGroups,
    query: deferredQuery,
    isInSubmenu: currentView !== null,
    botSearchItems,
    settingsSearchItems,
    threadSearchItems: allThreadItems,
  });
  const resultRows = buildCommandPaletteRows(displayedGroups);
  const isSubmenu = currentView !== null;

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: { modelPickerOpen: false },
    });
    if (threadJumpIndexFromCommand(command ?? "") !== null) {
      event.preventDefault();
      event.stopPropagation();
      const matchingItem = displayedGroups
        .flatMap((group) => group.items)
        .find((item) => item.shortcutCommand === command);
      if (matchingItem) {
        executeItem(matchingItem);
      }
      return;
    }
    if (command === "thread.copyReference") {
      event.preventDefault();
      event.stopPropagation();
      if (activeThreadReferenceCopyTarget === null) return;
      setOpen(false);
      void copyActiveThreadReference();
      return;
    }
    // ChatView ignores shortcuts while the palette is open, so handle find here
    // instead of letting the browser's own Find open.
    if (command === "chat.find" && activeThreadId && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      requestThreadFindOpen();
      return;
    }

    if (event.key === "Backspace" && query === "" && isSubmenu) {
      event.preventDefault();
      popView();
      return;
    }

    // Base UI ignores navigation keys with modifiers, so these fallbacks do too.
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    // Base UI keeps a hidden highlight on the first row.
    const firstItemValue = resultRows.itemValues[0];
    if (
      event.key === "ArrowDown" &&
      highlightClearedRef.current &&
      firstItemValue &&
      !event.nativeEvent.isComposing
    ) {
      (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
      event.preventDefault();
      highlightClearedRef.current = false;
      setHighlightedItemValue(firstItemValue);
      scrollCommandPaletteRowIntoView(
        resultListRef.current,
        resultRows.rowIndexByItemIndex[0] ?? 0,
      );
      return;
    }

    // Base UI clicks the highlighted row on Enter, which does nothing once the
    // virtualized list has unmounted it, so run the tracked highlight directly.
    if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      const highlightedItem = findHighlightedCommandPaletteItem(
        displayedGroups,
        highlightedItemValue ?? firstItemValue ?? null,
      );
      if (highlightedItem) {
        (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
        event.preventDefault();
        event.stopPropagation();
        executeItem(highlightedItem);
      }
    }
  }

  function executeItem(item: CommandPaletteActionItem | CommandPaletteSubmenuItem): void {
    if (item.disabled) {
      return;
    }

    if (item.kind === "submenu") {
      pushView(item);
      return;
    }

    if (!item.keepOpen) {
      setOpen(false);
    }

    void item.run().catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to run command",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
  }

  return (
    <CommandPaletteContent
      key={viewStack.length}
      aria-label="Command palette"
      autoHighlight="always"
      inputProps={{
        placeholder: getCommandPaletteInputPlaceholder(isSubmenu),
        ...(isSubmenu
          ? {
              startAddon: (
                <button
                  type="button"
                  className="flex cursor-pointer items-center"
                  aria-label="Back"
                  onClick={popView}
                >
                  <ArrowLeftIcon />
                </button>
              ),
            }
          : {}),
        onKeyDown: handleKeyDown,
      }}
      mode="none"
      items={resultRows.itemValues}
      virtualized
      onItemHighlighted={(value, eventDetails) => {
        if (eventDetails.reason === "none" && highlightClearedRef.current) return;
        highlightClearedRef.current = false;
        setHighlightedItemValue(typeof value === "string" ? value : null);
        const rowIndex = resultRows.rowIndexByItemIndex[eventDetails.index];
        if (eventDetails.reason === "keyboard" && rowIndex !== undefined) {
          scrollCommandPaletteRowIntoView(resultListRef.current, rowIndex);
        }
      }}
      onValueChange={handleQueryChange}
      showBackHint={isSubmenu}
      value={query}
    >
      <CommandPaletteVirtualizedResults
        rows={resultRows.rows}
        listRef={resultListRef}
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={isActionsOnly}
        keybindings={keybindings}
        onExecuteItem={executeItem}
        {...(threadSearch.isPending ? { emptyStateMessage: "Searching thread messages…" } : {})}
      />
    </CommandPaletteContent>
  );
}
