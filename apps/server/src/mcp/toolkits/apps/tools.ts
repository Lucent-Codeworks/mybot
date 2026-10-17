import { OrchestratorMcpFailure } from "@mybot/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as AppConnections from "../../../apps/AppConnections.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const AppId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)).annotate({
  description: "The app's id from app_tools_list.",
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  AppConnections.AppConnections,
];

const AppToolsListTool = Tool.make("app_tools_list", {
  description:
    "List the apps the user connected to MyBot, such as mail, calendar, or a CRM, and their tools. Without app, returns each app with its tool names and descriptions; with app, also returns each tool's input schema. Prefer a connected app over doing the same task in the browser. An app with an error cannot be used until it is fixed; when it needs the user to sign in, tell them where.",
  parameters: Schema.Struct({ app: Schema.optional(AppId) }),
  success: Schema.Struct({
    apps: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        error: Schema.NullOr(Schema.String),
        tools: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            description: Schema.String,
            inputSchema: Schema.optional(Schema.Unknown),
          }),
        ),
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List app tools")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const AppToolCallTool = Tool.make("app_tool_call", {
  description:
    "Run one tool of an app the user connected, with arguments matching the input schema from app_tools_list. Returns the app's result as-is. Tools that send, post, buy, or delete act for the user: draft first and get their go-ahead, as with anything else that acts for them.",
  parameters: Schema.Struct({
    app: AppId,
    tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
      description: "The tool's name from app_tools_list.",
    }),
    arguments: Schema.optional(
      Schema.Record(Schema.String, Schema.Unknown).annotate({
        description: "The tool's arguments, matching its input schema.",
      }),
    ),
  }),
  success: Schema.Struct({
    content: Schema.Unknown,
    structuredContent: Schema.optional(Schema.Unknown),
    isError: Schema.Boolean,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Use an app")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const AppsToolkit = Toolkit.make(AppToolsListTool, AppToolCallTool);
