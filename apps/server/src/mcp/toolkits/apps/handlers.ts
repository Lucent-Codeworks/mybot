import { OrchestratorMcpFailure } from "@mybot/contracts";
import * as Effect from "effect/Effect";

import * as AppConnections from "../../../apps/AppConnections.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AppsToolkit } from "./tools.ts";

const toFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/** Above this many tools, an app's listing leaves out what bots rarely need all of. */
export const LARGE_APP_TOOLS = 40;

/**
 * What app_tools_list shows of one app. Schemas only come for one app, so
 * listing every app stays short; a large app, such as Dialpad's whole API,
 * shows only names across apps and schemas only for the tools asked for.
 */
export const listedTools = (
  entry: AppConnections.AppTools,
  oneApp: boolean,
  only: ReadonlyArray<string> | undefined,
) => {
  const large = entry.tools.length > LARGE_APP_TOOLS;
  if (oneApp && only !== undefined) {
    const wanted = new Set(only);
    return { ...entry, tools: entry.tools.filter((tool) => wanted.has(tool.name)) };
  }
  return {
    ...entry,
    tools: entry.tools.map((tool) =>
      oneApp && !large
        ? tool
        : !oneApp && large
          ? { name: tool.name }
          : { name: tool.name, description: tool.description },
    ),
  };
};

export const layer = McpToolAccess.toLayer(AppsToolkit, {
  app_tools_list: McpToolAccess.reads(({ app, tools }) =>
    Effect.gen(function* () {
      const apps = yield* AppConnections.AppConnections;
      const found = yield* apps.tools(app).pipe(Effect.mapError(toFailure));
      return { apps: found.map((entry) => listedTools(entry, app !== undefined, tools)) };
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
