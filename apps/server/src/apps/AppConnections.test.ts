// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as AppConnections from "./AppConnections.ts";

const require = NodeModule.createRequire(import.meta.url);
const sdk = (path: string) => JSON.stringify(require.resolve(`@modelcontextprotocol/sdk/${path}`));

// A real MCP app on stdio with one tool, echo.
const ECHO_APP = `
const load = async (path) => { const mod = await import(path); return { ...mod.default, ...mod }; };
const { Server } = await load(${sdk("server/index.js")});
const { StdioServerTransport } = await load(${sdk("server/stdio.js")});
const { ListToolsRequestSchema, CallToolRequestSchema } = await load(${sdk("types.js")});
const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: "echo: " + request.params.arguments.text }],
}));
await server.connect(new StdioServerTransport());
`;

const echoAppPath = NodePath.join(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-echo-app-")),
  "echo-app.mjs",
);
NodeFS.writeFileSync(echoAppPath, ECHO_APP);

const echoApp = {
  name: "Echo Tools",
  transport: {
    type: "stdio" as const,
    command: process.execPath,
    args: [echoAppPath],
  },
};

const layerTest = AppConnections.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-app-connections-" })),
  Layer.provideMerge(NodeServices.layer),
);

describe("AppConnections", () => {
  it("names connections uniquely from the app name", () => {
    expect(AppConnections.connectionIdFor("Google Calendar", [])).toBe("google-calendar");
    expect(AppConnections.connectionIdFor("Gmail", ["gmail", "gmail-2"])).toBe("gmail-3");
    expect(AppConnections.connectionIdFor("!!!", [])).toBe("app");
  });

  it.live("connects an app, relays its tools and calls, and removes it", () =>
    Effect.gen(function* () {
      const apps = yield* AppConnections.AppConnections;

      const added = yield* apps.add(echoApp);
      expect(added.connections).toEqual([
        expect.objectContaining({
          id: "echo-tools",
          name: "Echo Tools",
          toolCount: 1,
          error: null,
        }),
      ]);

      const [tools] = yield* apps.tools("echo-tools");
      expect(tools?.tools.map((tool) => tool.name)).toEqual(["echo"]);
      expect(tools?.tools[0]?.inputSchema).toMatchObject({ type: "object" });

      const result = yield* apps.call("echo-tools", "echo", { text: "hi" });
      expect(result).toEqual({ content: [{ type: "text", text: "echo: hi" }], isError: false });

      const unknownTool = yield* apps.call("echo-tools", "send", {}).pipe(Effect.flip);
      expect(unknownTool.message).toContain('has no tool "send"');

      const removed = yield* apps.remove("echo-tools");
      expect(removed.connections).toEqual([]);
      const gone = yield* apps.call("echo-tools", "echo", {}).pipe(Effect.flip);
      expect(gone.message).toContain('No connected app "echo-tools"');
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("does not save an app it cannot connect to", () =>
    Effect.gen(function* () {
      const apps = yield* AppConnections.AppConnections;
      const error = yield* apps
        .add({
          name: "Broken",
          transport: { type: "stdio", command: process.execPath, args: ["-e", "process.exit(1)"] },
        })
        .pipe(Effect.flip);
      expect(error.message).toContain("Could not connect to Broken.");
      expect((yield* apps.list).connections).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );
});
