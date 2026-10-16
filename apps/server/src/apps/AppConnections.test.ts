// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as AppConnections from "./AppConnections.ts";
import * as LocalRuntimes from "./LocalRuntimes.ts";

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

// The same echo app over Streamable HTTP, answering with event streams, behind a token.
const startHttpEchoApp = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<NodeHttp.Server>((resolve) => {
        const httpServer = NodeHttp.createServer(async (request, response) => {
          if (request.headers.authorization !== "Bearer secret") {
            response.writeHead(401).end();
            return;
          }
          const server = new Server(
            { name: "echo", version: "1.0.0" },
            { capabilities: { tools: {} } },
          );
          server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [{ name: "echo", inputSchema: { type: "object" } }],
          }));
          server.setRequestHandler(CallToolRequestSchema, async (call) => ({
            content: [{ type: "text", text: `echo: ${String(call.params.arguments?.text)}` }],
          }));
          const transport = new StreamableHTTPServerTransport({});
          await server.connect(transport as Parameters<typeof server.connect>[0]);
          await transport.handleRequest(request, response);
        });
        httpServer.listen(0, "127.0.0.1", () => resolve(httpServer));
      }),
  ),
  (httpServer) =>
    Effect.promise(() => new Promise<void>((resolve) => httpServer.close(() => resolve()))),
).pipe(
  Effect.map((httpServer) => {
    const address = httpServer.address();
    return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
  }),
);

const layerTest = AppConnections.layer.pipe(
  Layer.provideMerge(LocalRuntimes.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-app-connections-" })),
  Layer.provideMerge(FetchHttpClient.layer),
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
          // The command only: arguments and environment may hold secrets.
          target: process.execPath,
          status: "ready",
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

  it.live("connects an app over HTTP with its access token", () =>
    Effect.gen(function* () {
      const url = yield* startHttpEchoApp;
      const apps = yield* AppConnections.AppConnections;

      const refused = yield* apps
        .add({ name: "Echo Web", transport: { type: "http", url, bearerToken: "wrong" } })
        .pipe(Effect.flip);
      expect(refused.message).toContain("refused access");

      const added = yield* apps.add({
        name: "Echo Web",
        transport: { type: "http", url, bearerToken: "secret" },
      });
      expect(added.connections).toEqual([
        expect.objectContaining({ id: "echo-web", toolCount: 1, error: null }),
      ]);
      const result = yield* apps.call("echo-web", "echo", { text: "web" });
      expect(result.content).toEqual([{ type: "text", text: "echo: web" }]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("uses the protocol version the app chose for every later request", () =>
    Effect.gen(function* () {
      // Like Telnyx: it answers initialize with its version and refuses requests without it.
      const url = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeHttp.Server>((resolve) => {
              const httpServer = NodeHttp.createServer((request, response) => {
                let body = "";
                request.on("data", (chunk) => (body += chunk));
                request.on("end", () => {
                  const message = JSON.parse(body) as { id?: number; method: string };
                  const reply = (payload: object, status = 200) =>
                    response
                      .writeHead(status, { "content-type": "application/json" })
                      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, ...payload }));
                  if (message.method === "initialize") {
                    reply({ result: { protocolVersion: "2099-01-01", capabilities: {} } });
                  } else if (request.headers["mcp-protocol-version"] !== "2099-01-01") {
                    reply(
                      { error: { code: -32000, message: "Unsupported protocol version" } },
                      400,
                    );
                  } else if (message.method === "tools/list") {
                    reply({
                      result: { tools: [{ name: "ping", inputSchema: { type: "object" } }] },
                    });
                  } else {
                    response.writeHead(202).end();
                  }
                });
              });
              httpServer.listen(0, "127.0.0.1", () => resolve(httpServer));
            }),
        ),
        (httpServer) =>
          Effect.promise(() => new Promise<void>((resolve) => httpServer.close(() => resolve()))),
      ).pipe(
        Effect.map((httpServer) => {
          const address = httpServer.address();
          return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
        }),
      );
      const apps = yield* AppConnections.AppConnections;
      const added = yield* apps.add({ name: "Versioned", transport: { type: "http", url } });
      expect(added.connections).toEqual([
        expect.objectContaining({ id: "versioned", toolCount: 1, error: null }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
