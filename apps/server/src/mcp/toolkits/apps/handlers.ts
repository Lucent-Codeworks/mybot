import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AppConnections from "../../../apps/AppConnections.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AppsToolkit } from "./tools.ts";

const toFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

export const layer = McpToolAccess.toLayer(AppsToolkit, {
  app_tools_list: McpToolAccess.reads(({ app }) =>
    Effect.gen(function* () {
      const apps = yield* AppConnections.AppConnections;
      const found = yield* apps.tools(app).pipe(Effect.mapError(toFailure));
      return {
        apps: found.map((entry) => ({
          ...entry,
          // Schemas only for one app, so listing every app stays short.
          tools: entry.tools.map((tool) =>
            app === undefined ? { name: tool.name, description: tool.description } : tool,
          ),
        })),
      };
    }),
  ),
  // Connected apps act in the user's accounts, so read-only clients cannot call them.
  app_tool_call: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const apps = yield* AppConnections.AppConnections;
      return yield* apps
        .call(input.app, input.tool, input.arguments ?? {})
        .pipe(Effect.mapError(toFailure));
    }),
  ),
});
