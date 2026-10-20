import type { McpRequestOptions, McpSession, McpTransportConfig } from "../mcpClient.ts";
import { dialpadApp } from "./dialpad.ts";

/**
 * Apps MyBot runs itself, in process, instead of starting or calling an MCP
 * server. Each answers the same MCP methods connected apps do, so the rest of
 * AppConnections cannot tell them apart. In process because the server ships
 * as a single executable that cannot start a bundled script.
 */

export interface BuiltinTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** The tool's result, shown to the bot as JSON. Throws a ToolError for a reason the bot should read. */
  readonly run: (args: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<unknown>;
}

export interface BuiltinApp {
  readonly name: string;
  /** Runs while connecting, so a wrong key is reported instead of saved. */
  readonly check: (signal: AbortSignal) => Promise<void>;
  readonly tools: ReadonlyArray<BuiltinTool>;
}

/** A failed tool call the bot should read and can act on, such as a missing argument. */
export class ToolError extends Error {}

type BuiltinTransport = Extract<McpTransportConfig, { type: "builtin" }>;

const appFor = (config: BuiltinTransport): BuiltinApp => {
  switch (config.app) {
    case "dialpad":
      return dialpadApp(config.apiKey);
  }
};

const withTimeout = (options: McpRequestOptions) =>
  options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
    : AbortSignal.timeout(options.timeoutMs);

const textResult = (text: string, isError: boolean) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

export const connectBuiltin = (config: BuiltinTransport): McpSession =>
  builtinSession(appFor(config));

/** An MCP session answered by `app` in process. */
export function builtinSession(app: BuiltinApp): McpSession {
  let closed = false;
  return {
    request: async (method, params, options) => {
      if (closed) throw new Error("The app connection closed.");
      const signal = withTimeout(options);
      switch (method) {
        case "initialize":
          await app.check(signal);
          return {
            protocolVersion: params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: app.name, version: "1.0.0" },
          };
        case "tools/list":
          return {
            tools: app.tools.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          };
        case "tools/call": {
          const tool = app.tools.find((candidate) => candidate.name === params.name);
          if (!tool) return textResult(`Unknown tool ${String(params.name)}.`, true);
          const args =
            typeof params.arguments === "object" && params.arguments !== null
              ? (params.arguments as Record<string, unknown>)
              : {};
          try {
            const result = await tool.run(args, signal);
            return textResult(JSON.stringify(result ?? { ok: true }, null, 2), false);
          } catch (error) {
            if (error instanceof ToolError) return textResult(error.message, true);
            throw error;
          }
        }
        default:
          throw new Error(`Method not found: ${method}`);
      }
    },
    notify: async () => undefined,
    useProtocolVersion: () => undefined,
    close: async () => {
      closed = true;
    },
  };
}
