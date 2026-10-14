import type {
  EditorId,
  EnvironmentId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";

import type { DraftId } from "../../composerDraftStore";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";
import { type EnvironmentOption } from "../ComposerContextStrip.logic";
import { ComposerContextStrip } from "../ComposerContextStrip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import type { ComponentProps } from "react";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

export interface ThreadDetailsPanelProps extends Pick<
  ComponentProps<typeof ThreadDetailsCard>,
  "anchor" | "handle" | "onPresentationChange"
> {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  /** The project folder the thread runs in. */
  workspaceRoot: string | null;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  onEnvironmentChange: (environmentId: EnvironmentId) => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const fileScripts = useT3ProjectFileScripts(
    props.environmentId,
    props.activeProjectScripts ? props.workspaceRoot : null,
  );
  return (
    <ThreadDetailsCard
      threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
      anchor={props.anchor}
      handle={props.handle}
      onPresentationChange={props.onPresentationChange}
    >
      {(density) => (
        <>
          <ThreadDetailsSection
            headingId="thread-details-workspace-heading"
            title="Workspace"
            separated={false}
            showHeading={false}
          >
            <div className="flex flex-col">
              {density === "full" ? (
                <ComposerContextStrip
                  layout="panel"
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  {...(props.draftId ? { draftId: props.draftId } : {})}
                  envLocked={props.envLocked}
                  availableEnvironments={props.availableEnvironments}
                  onEnvironmentChange={props.onEnvironmentChange}
                  autoEnvironmentLabel={props.autoEnvironmentLabel}
                  onAutoEnvironment={props.onAutoEnvironment}
                />
              ) : null}

              {density !== "essential" && props.showOpenInPicker ? (
                <OpenInPicker
                  keybindings={props.keybindings}
                  environmentId={props.environmentId}
                  availableEditors={props.availableEditors}
                  openInCwd={props.workspaceRoot}
                  displayMode="panel"
                />
              ) : null}

              {props.activeProjectScripts ? (
                <ProjectScriptsControl
                  environmentId={props.environmentId}
                  displayMode="panel"
                  scripts={props.activeProjectScripts}
                  fileScripts={fileScripts}
                  preferredScriptId={props.preferredScriptId}
                  onRunScript={props.onRunProjectScript}
                  onAddScript={props.onAddProjectScript}
                  onUpdateScript={props.onUpdateProjectScript}
                  onDeleteScript={props.onDeleteProjectScript}
                />
              ) : null}
            </div>
          </ThreadDetailsSection>

          {density === "full" && !props.draftId ? (
            <ThreadAutomationsPanel environmentId={props.environmentId} threadId={props.threadId} />
          ) : null}

          {density === "full" && !props.draftId ? (
            <ThreadRelationshipsPanel
              environmentId={props.environmentId}
              threadId={props.threadId}
            />
          ) : null}
        </>
      )}
    </ThreadDetailsCard>
  );
}
