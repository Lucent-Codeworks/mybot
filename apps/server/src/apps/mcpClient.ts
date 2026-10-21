// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// Promise-based so it runs inside Effect.tryPromise with that fiber's abort signal.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import { connectBuiltin } from "./builtin/index.ts";

/**
 * The few MCP client calls connected apps need (initialize, tools/list,
 * tools/call) over stdio or Streamable HTTP, or in process for built-in
 * apps (builtin/). Kept dependency-free: the official SDK pulls file-backed
 * packages that the server's single executable cannot load.
 */

/** The newest MCP version we speak; the app answers with the version both sides then use. */
const PROTOCOL_VERSION = "2025-11-25";

/** OAuth access for an HTTP app; see mcpOAuth.ts. */
export interface McpAccessTokens {
  /** The current access token, refreshed first if it expired; undefined before sign-in. */
  readonly token: () => Promise<string | undefined>;
  /** A new access token after the app refused the current one; undefined when the user must sign in again. */
  readonly refresh: () => Promise<string | undefined>;
}

/** The app answered 401: it needs a (new) token or a browser sign-in. */
export class McpAuthorizationError extends Error {
  /** The app's `WWW-Authenticate` header, which may point at its OAuth metadata. */
  readonly wwwAuthenticate: string | null;
  constructor(message: string, wwwAuthenticate: string | null) {
    super(message);
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

export type McpTransportConfig =
  | {
      readonly type: "http";
      readonly url: string;
      readonly bearerToken?: string | undefined;
      readonly accessTokens?: McpAccessTokens | undefined;
    }
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env?: Readonly<Record<string, string>> | undefined;
    }
  | {
      /** An app MyBot runs itself; see builtin/. */
      readonly type: "builtin";
      readonly app: "dialpad";
      readonly apiKey: string;
    };

export interface McpRequestOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
}

export interface McpConnection {
  readonly request: (
    method: string,
    params: Record<string, unknown>,
    options: McpRequestOptions,
  ) => Promise<Record<string, unknown>>;
  readonly close: () => Promise<void>;
}

export interface McpSession extends McpConnection {
  readonly notify: (method: string) => Promise<void>;
  /** Records the protocol version the app chose in its initialize answer. */
  readonly useProtocolVersion: (version: string) => void;
}

interface JsonRpcMessage {
  readonly id?: number | string | null;
  readonly method?: string;
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const resultOf = (message: JsonRpcMessage): Record<string, unknown> => {
  if (message.error) {
    throw new Error(
      typeof message.error.message === "string"
        ? message.error.message
        : "The app returned an error.",
    );
  }
  return asRecord(message.result);
};

const parseMessage = (text: string): JsonRpcMessage | null => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as JsonRpcMessage) : null;
  } catch {
    return null;
  }
};

const withTimeout = (options: McpRequestOptions) =>
  options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
    : AbortSignal.timeout(options.timeoutMs);

/** Variables a local app gets from MyBot's own environment, before its configured ones. */
const INHERITED_ENV = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "LANG", "TMPDIR"];
const INHERITED_ENV_WINDOWS = [
  "APPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERNAME",
  "USERPROFILE",
  "PROGRAMFILES",
];

function appEnvironment(
  platform: NodeJS.Platform,
  configured: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of platform === "win32" ? INHERITED_ENV_WINDOWS : INHERITED_ENV) {
    const value = process.env[key];
    if (value !== undefined && !value.startsWith("()")) env[key] = value;
  }
  return { ...env, ...configured };
}

function connectStdio(
  config: Extract<McpTransportConfig, { type: "stdio" }>,
  platform: NodeJS.Platform,
): McpSession {
  const child = NodeChildProcess.spawn(config.command, [...config.args], {
    env: appEnvironment(platform, config.env),
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    shell: false,
  });
  const pending = new Map<number, (message: JsonRpcMessage | Error) => void>();
  let nextId = 1;
  let closedError: Error | null = null;
  const failAll = (error: Error) => {
    closedError ??= error;
    for (const settle of pending.values()) settle(error);
    pending.clear();
  };
  const write = (message: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  child.on("error", (error) => failAll(error));
  child.on("exit", (code) => failAll(new Error(`The app exited (code ${code ?? "unknown"}).`)));
  child.stdin.on("error", (error) => failAll(error));
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = parseMessage(line);
    if (!message) return;
    if (message.method !== undefined) {
      // Requests from the app, such as ping; MyBot offers no client features.
      if (message.id !== undefined && message.id !== null) {
        write(
          message.method === "ping"
            ? { id: message.id, result: {} }
            : { id: message.id, error: { code: -32601, message: "Method not found" } },
        );
      }
      return;
    }
    if (typeof message.id !== "number") return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });

  return {
    request: (method, params, options) =>
      new Promise((resolve, reject) => {
        if (closedError) return reject(closedError);
        const id = nextId++;
        const signal = withTimeout(options);
        const onAbort = () => {
          pending.delete(id);
          reject(new Error(`The app did not answer ${method} in time.`));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.set(id, (message) => {
          signal.removeEventListener("abort", onAbort);
          if (message instanceof Error) return reject(message);
          try {
            resolve(resultOf(message));
          } catch (error) {
            reject(error);
          }
        });
        write({ id, method, params });
      }),
    notify: async (method) => write({ method }),
    useProtocolVersion: () => undefined,
    close: async () => {
      failAll(new Error("The app connection closed."));
      child.stdin.end();
      child.kill();
    },
  };
}

/** Reads a server-sent event stream until the response with `id` arrives. */
async function readEventStream(
  body: ReadableStream<Uint8Array>,
  id: number,
): Promise<JsonRpcMessage> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        const message = parseMessage(data);
        if (message && message.method === undefined && message.id === id) return message;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error("The app closed the response without an answer.");
}

function connectHttp(config: Extract<McpTransportConfig, { type: "http" }>): McpSession {
  const url = new URL(config.url);
  const accessTokens = config.accessTokens;
  let sessionId: string | null = null;
  let token: string | undefined = config.bearerToken || undefined;
  let nextId = 1;
  // Requests after initialize carry the version the app chose in its answer.
  let protocolVersion: string | null = null;
  const headers = () => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  });
  const post = async (message: Record<string, unknown>, signal: AbortSignal) => {
    const send = () =>
      fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ jsonrpc: "2.0", ...message }),
        signal,
      });
    if (accessTokens) token = await accessTokens.token();
    let response = await send();
    if (response.status === 401 && accessTokens && token !== undefined) {
      // The token expired or was revoked early: refresh once and retry.
      await response.body?.cancel().catch(() => undefined);
      token = await accessTokens.refresh();
      if (token !== undefined) response = await send();
    }
    if (!response.ok) {
      // Only a JSON-RPC error message from the body is shown; nothing else of it.
      const reason =
        response.status === 401
          ? (await response.body?.cancel().catch(() => undefined), null)
          : parseMessage(await response.text().catch(() => ""));
      if (response.status === 401) {
        throw new McpAuthorizationError(
          accessTokens
            ? "The app needs you to sign in."
            : "The app refused access (HTTP 401). Check its access token.",
          response.headers.get("www-authenticate"),
        );
      }
      throw new Error(
        response.status === 403
          ? "The app refused access (HTTP 403). Your account may not have access to it."
          : `The app answered HTTP ${response.status}${
              typeof reason?.error?.message === "string"
                ? `: ${reason.error.message.slice(0, 200)}`
                : "."
            }`,
      );
    }
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    return response;
  };

  return {
    request: async (method, params, options) => {
      const id = nextId++;
      const signal = withTimeout(options);
      const response = await post({ id, method, params }, signal);
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream") && response.body) {
        return resultOf(await readEventStream(response.body, id));
      }
      const message = parseMessage(await response.text());
      if (!message) throw new Error("The app's answer was not JSON-RPC.");
      return resultOf(message);
    },
    useProtocolVersion: (version) => {
      protocolVersion = version;
    },
    notify: async (method) => {
      const response = await post({ method }, AbortSignal.timeout(10_000));
      await response.body?.cancel().catch(() => undefined);
    },
    close: async () => {
      if (!sessionId) return;
      await fetch(url, { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(5_000) })
        .then((response) => response.body?.cancel())
        .catch(() => undefined);
    },
  };
}

/** Starts or opens the app and completes the MCP handshake. */
export async function connectMcp(
  config: McpTransportConfig,
  options: McpRequestOptions,
  platform: NodeJS.Platform,
): Promise<McpConnection> {
  if (config.type === "http" && !URL.canParse(config.url)) {
    throw new Error(`${config.url} is not a URL.`);
  }
  const connection =
    config.type === "http"
      ? connectHttp(config)
      : config.type === "stdio"
        ? connectStdio(config, platform)
        : connectBuiltin(config);
  try {
    const initialized = await connection.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "mybot", version: "1.0.0" },
      },
      options,
    );
    connection.useProtocolVersion(
      typeof initialized.protocolVersion === "string"
        ? initialized.protocolVersion
        : PROTOCOL_VERSION,
    );
    await connection.notify("notifications/initialized");
    return connection;
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}
