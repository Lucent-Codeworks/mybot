import type { EnvironmentId, ProjectScript, ThreadId } from "@mybot/contracts";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useMemo } from "react";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import {
  basename,
  getTerminalStatusLabel,
  projectScriptMenuIcon,
  type TerminalMenuSession,
} from "../terminal/terminalMenu";

type HeaderItem = Record<string, unknown>;
type HeaderItems = HeaderItem[];
type ThreadHeaderActionItems = {
  readonly terminal: HeaderItem;
  readonly files: HeaderItem;
  readonly mergeBack: HeaderItem | null;
};

export type ThreadHeaderControlsProps = {
  readonly environmentId: EnvironmentId | string;
  readonly threadId: ThreadId | string;
  readonly onOpenFilesInspector?: () => void;
  /** Present only on a thread whose work can be merged into the one it came from. */
  readonly onMergeBack?: () => void;
  readonly auxiliaryPaneControl?: {
    readonly accessibilityLabel: string;
    readonly onPress: () => void;
  };
  readonly canOpenTerminal: boolean;
  readonly canOperateTerminal: boolean;
  readonly canOpenFiles: boolean;
  readonly projectScripts: ReadonlyArray<ProjectScript>;
  readonly terminalSessions: ReadonlyArray<TerminalMenuSession>;
  readonly showActionControls?: boolean;
  readonly showDirectFileControl?: boolean;
  readonly onOpenTerminal: (terminalId?: string | null) => void;
  readonly onOpenNewTerminal: () => void;
  readonly onRunProjectScript: (script: ProjectScript) => Promise<void>;
};

function useOpenFiles(props: ThreadHeaderControlsProps) {
  const navigation = useNavigation();
  const { environmentId, threadId, onOpenFilesInspector } = props;
  return useCallback(() => {
    if (onOpenFilesInspector) {
      onOpenFilesInspector();
      return;
    }
    navigation.navigate("ThreadFiles", {
      environmentId: String(environmentId),
      threadId: String(threadId),
    });
  }, [environmentId, onOpenFilesInspector, navigation, threadId]);
}

function useThreadHeaderActionItems(props: ThreadHeaderControlsProps): ThreadHeaderActionItems {
  const openFiles = useOpenFiles(props);

  return useMemo(
    () => ({
      terminal: {
        accessibilityLabel: "Open terminal",
        disabled: !props.canOpenTerminal,
        icon: { name: "terminal", type: "sfSymbol" },
        identifier: "thread-right-terminal",
        label: "Terminal",
        menu: {
          items: [
            ...props.projectScripts.map((script) => ({
              description: script.command,
              disabled: !props.canOperateTerminal,
              icon: { name: projectScriptMenuIcon(script.icon), type: "sfSymbol" as const },
              label: script.name,
              onPress: () => void props.onRunProjectScript(script),
              type: "action" as const,
            })),
            ...(props.projectScripts.length === 0
              ? [
                  {
                    description: "This project has no saved scripts yet",
                    disabled: true,
                    icon: { name: "play", type: "sfSymbol" as const },
                    label: "No project scripts",
                    onPress: () => {},
                    type: "action" as const,
                  },
                ]
              : []),
            ...props.terminalSessions.map((session) => ({
              description: [
                getTerminalStatusLabel({
                  status: session.status,
                  hasRunningSubprocess: session.hasRunningSubprocess,
                }),
                basename(session.cwd),
              ]
                .filter(Boolean)
                .join(" · "),
              icon: { name: "terminal", type: "sfSymbol" as const },
              label: session.displayLabel,
              onPress: () => props.onOpenTerminal(session.terminalId),
              type: "action" as const,
            })),
            {
              description: "Start another shell for this thread",
              disabled: !props.canOperateTerminal,
              icon: { name: "plus", type: "sfSymbol" },
              label: "Open new terminal",
              onPress: props.onOpenNewTerminal,
              type: "action",
            },
          ],
          title: "Terminal",
        },
        sharesBackground: true,
        type: "menu",
        variant: "plain",
      },
      files: {
        accessibilityLabel: "Open files",
        disabled: !props.canOpenFiles,
        icon: { name: "folder", type: "sfSymbol" },
        identifier: "thread-right-files",
        label: "Files",
        onPress: openFiles,
        sharesBackground: true,
        type: "button",
        variant: "plain",
      },
      mergeBack: props.onMergeBack
        ? {
            accessibilityLabel: "Merge back to source",
            icon: { name: "arrow.triangle.merge", type: "sfSymbol" },
            identifier: "thread-right-merge-back",
            label: "Merge back",
            onPress: props.onMergeBack,
            sharesBackground: true,
            type: "button",
            variant: "plain",
          }
        : null,
    }),
    [
      openFiles,
      props.canOpenFiles,
      props.canOpenTerminal,
      props.canOperateTerminal,
      props.onMergeBack,
      props.onOpenNewTerminal,
      props.onOpenTerminal,
      props.onRunProjectScript,
      props.projectScripts,
      props.terminalSessions,
    ],
  );
}

export function useThreadRightHeaderItems(props: ThreadHeaderControlsProps): HeaderItems {
  const actionItems = useThreadHeaderActionItems(props);
  return useMemo(
    () =>
      [
        ...(actionItems.mergeBack ? [actionItems.mergeBack] : []),
        actionItems.files,
        actionItems.terminal,
      ] as HeaderItems,
    [actionItems],
  );
}

export function useThreadCenterHeaderItems(props: ThreadHeaderControlsProps): HeaderItems {
  const actionItems = useThreadHeaderActionItems(props);
  return useMemo(
    () =>
      [
        actionItems.files,
        ...(actionItems.mergeBack ? [actionItems.mergeBack] : []),
        actionItems.terminal,
      ] as HeaderItems,
    [actionItems],
  );
}

export function ThreadHeaderControls(props: ThreadHeaderControlsProps) {
  const openFiles = useOpenFiles(props);
  const showActionControls = props.showActionControls ?? true;

  if (!showActionControls) {
    return null;
  }

  return (
    <NativeHeaderToolbar placement="right">
      {props.auxiliaryPaneControl ? (
        <NativeHeaderToolbar.Button
          accessibilityLabel={props.auxiliaryPaneControl.accessibilityLabel}
          icon="sidebar.right"
          onPress={props.auxiliaryPaneControl.onPress}
          separateBackground
        />
      ) : null}
      <NativeHeaderToolbar.Menu
        accessibilityLabel="Open terminal"
        icon="terminal"
        disabled={!props.canOpenTerminal}
        separateBackground
      >
        {props.projectScripts.length > 0 ? (
          props.projectScripts.map((script) => (
            <NativeHeaderToolbar.MenuAction
              key={script.id}
              icon={projectScriptMenuIcon(script.icon)}
              disabled={!props.canOperateTerminal}
              onPress={() => void props.onRunProjectScript(script)}
              subtitle={script.command}
            >
              <NativeHeaderToolbar.Label>{script.name}</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          ))
        ) : (
          <NativeHeaderToolbar.MenuAction
            icon="play"
            disabled
            onPress={() => {}}
            subtitle="This project has no saved scripts yet"
          >
            <NativeHeaderToolbar.Label>No project scripts</NativeHeaderToolbar.Label>
          </NativeHeaderToolbar.MenuAction>
        )}
        {props.terminalSessions.map((session) => (
          <NativeHeaderToolbar.MenuAction
            key={session.terminalId}
            icon="terminal"
            onPress={() => props.onOpenTerminal(session.terminalId)}
            subtitle={[
              getTerminalStatusLabel({
                status: session.status,
                hasRunningSubprocess: session.hasRunningSubprocess,
              }),
              basename(session.cwd),
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            <NativeHeaderToolbar.Label>{session.displayLabel}</NativeHeaderToolbar.Label>
          </NativeHeaderToolbar.MenuAction>
        ))}
        <NativeHeaderToolbar.MenuAction
          icon="plus"
          disabled={!props.canOperateTerminal}
          onPress={props.onOpenNewTerminal}
          subtitle="Start another shell for this thread"
        >
          <NativeHeaderToolbar.Label>Open new terminal</NativeHeaderToolbar.Label>
        </NativeHeaderToolbar.MenuAction>
      </NativeHeaderToolbar.Menu>
      {props.showDirectFileControl ? (
        <NativeHeaderToolbar.Button
          accessibilityLabel="Open files"
          disabled={!props.canOpenFiles}
          icon="folder"
          onPress={openFiles}
          separateBackground
        />
      ) : null}
      {props.onMergeBack ? (
        <NativeHeaderToolbar.Button
          accessibilityLabel="Merge back to source"
          icon="arrow.triangle.merge"
          onPress={props.onMergeBack}
          separateBackground
        />
      ) : null}
    </NativeHeaderToolbar>
  );
}
