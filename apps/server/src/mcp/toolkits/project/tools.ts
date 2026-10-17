import { McpAttachmentInput } from "../attachment/input.ts";
import {
  NonNegativeInt,
  ModelSelection,
  TrimmedNonEmptyString,
  ThreadId,
  RunId,
  OrchestrationV2RunStatus,
  RuntimeMode,
  ProviderInteractionMode,
  Project,
  ProjectCreatePayload,
  ProjectUpdatePayload,
  ProjectId,
  OrchestratorMcpFailure,
} from "@mybot/contracts";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  success: Project,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    Crypto.Crypto,
  ],
};
const ProjectListTool = Tool.make("t3_project_list", {
  ...shared,
  description:
    "List registered projects in this environment. Pages use the current project snapshot and may shift between calls.",
  parameters: Schema.Struct({
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    projects: Schema.Array(Project),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectReadTool = Tool.make("t3_project_read", {
  ...shared,
  description:
    "Read a registered project in this environment, including its workspace and saved scripts.",
  parameters: Schema.Struct({ projectId: ProjectId }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectCreateTool = Tool.make("t3_project_create", {
  ...shared,
  description:
    "Create a bot. In MyBot every project is a bot: a named teammate whose profile every turn in its threads receives, so bot ({role, instructions}) is required. Set defaultModelSelection for the model its threads start with. Omit workspaceRoot to start the bot from just its title: the app makes a folder for it in its own projects folder, with a README, a memory file, and an icon. Or pass workspaceRoot to give the bot an existing directory; set createWorkspaceRootIfMissing to create it. Only create a bot when the user asks for one or agrees to it. Each call creates a new request; an existing registered workspace is rejected.",
  parameters: Schema.Struct({
    ...ProjectCreatePayload.fields,
    workspaceRoot: Schema.optional(ProjectCreatePayload.fields.workspaceRoot),
  }),
  dependencies: [...shared.dependencies, ManagedProjectFolders.ManagedProjectFolders],
}).annotate(Tool.Destructive, true);
const ProjectUpdateTool = Tool.make("t3_project_update", {
  ...shared,
  description:
    "Update a bot's settings. Omitted fields are preserved. Set bot to edit its role and instructions; bot:null is rejected because every project is a bot. Uses the same project service as the app.",
  parameters: Schema.Struct({ projectId: ProjectId, ...ProjectUpdatePayload.fields }),
}).annotate(Tool.Destructive, true);
const ProjectDeleteTool = Tool.make("t3_project_delete", {
  ...shared,
  description:
    "Delete a project using the existing project deletion lifecycle. Nonempty projects require force=true. This does not delete the project directory or promise a deleted-thread count.",
  parameters: Schema.Struct({ projectId: ProjectId, force: Schema.optionalKey(Schema.Boolean) }),
}).annotate(Tool.Destructive, true);
const ThreadLaunchTool = Tool.make("t3_thread_launch", {
  ...shared,
  description:
    "Create an ordinary TOP-LEVEL thread. Use this when the user requests independent work or a new thread; use delegate_task for child subagents. The thread runs in its project's folder. Omit projectId/modelSelection/modes to inherit those settings from the calling thread; a caller outside a MyBot thread must pass projectId and gets the project's default model. Put the task in message. Each call creates a new launch with no retry key; retain threadId and use t3_thread_read/t3_thread_wait to follow preparation. To link a thread for the user, write `[title](t3-thread://v1/<threadId>)` with the threadId exactly as returned, not URL-encoded; MyBot shows the thread's current title. After errors or lost responses, inspect t3_thread_list before retrying. Attachments must be pending uploads. The new thread may not run with broader runtime or interaction modes than the caller: the calling MyBot thread's own modes, or the permission mode an outside agent was approved with.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    title: TrimmedNonEmptyString,
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    message: Schema.optional(
      Schema.String.check(Schema.isMaxLength(120000)).annotate({
        description:
          "First task prompt, delivered after workspace preparation. Omit message and attachments to create an idle thread.",
      }),
    ),
    attachments: Schema.optional(Schema.Array(McpAttachmentInput).check(Schema.isMaxLength(8))),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runId: Schema.NullOr(RunId),
    status: Schema.NullOr(OrchestrationV2RunStatus),
  }),
  dependencies: [
    ...shared.dependencies,
    ThreadLaunchService.ThreadLaunchService,
    FileSystem.FileSystem,
    ServerConfig.ServerConfig,
    ServerSettings.ServerSettingsService,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ProjectToolkit = Toolkit.make(
  ThreadLaunchTool,
  ProjectListTool,
  ProjectReadTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectDeleteTool,
);
