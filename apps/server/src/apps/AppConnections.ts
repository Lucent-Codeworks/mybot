import {
  AppConnectionAddInput,
  AppConnectionError,
  AppConnectionId,
  type AppConnectionList,
  type AppConnectionSummary,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { connectMcp, type McpConnection } from "./mcpClient.ts";

/**
 * Apps a user connected for their bots. Each app is an MCP server; MyBot
 * connects to it and relays its tools to every bot through the app_tools_list
 * and app_tool_call tools, so it works the same for every provider. Configs,
 * including tokens, live in the server secret store.
 */

const StoredConnection = Schema.Struct({
  id: AppConnectionId,
  name: Schema.String,
  transport: AppConnectionAddInput.fields.transport,
});
type StoredConnection = typeof StoredConnection.Type;
const StoredConnectionsJson = Schema.fromJsonString(Schema.Array(StoredConnection));
const decodeStored = Schema.decodeUnknownOption(StoredConnectionsJson);
const encodeStored = Schema.encodeSync(StoredConnectionsJson);

const SECRET_NAME = "app-connections";
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 5 * 60_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface AppTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface AppTools {
  readonly id: string;
  readonly name: string;
  readonly tools: ReadonlyArray<AppTool>;
  readonly error: string | null;
}

export interface AppToolResult {
  readonly content: unknown;
  readonly structuredContent?: unknown;
  readonly isError: boolean;
}

export class AppConnections extends Context.Service<
  AppConnections,
  {
    readonly list: Effect.Effect<AppConnectionList, AppConnectionError>;
    /** Connects to the app first, so a wrong URL or command is reported instead of saved. */
    readonly add: (
      input: AppConnectionAddInput,
    ) => Effect.Effect<AppConnectionList, AppConnectionError>;
    readonly remove: (id: string) => Effect.Effect<AppConnectionList, AppConnectionError>;
    /** Every app's tools, or one app's. */
    readonly tools: (id?: string) => Effect.Effect<ReadonlyArray<AppTools>, AppConnectionError>;
    readonly call: (
      id: string,
      tool: string,
      args: Record<string, unknown>,
    ) => Effect.Effect<AppToolResult, AppConnectionError>;
  }
>()("t3/apps/AppConnections") {}

/** A lowercase id from the app's name that no other connection uses. */
export const connectionIdFor = (name: string, taken: ReadonlyArray<string>): string => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "app";
  let id = base;
  for (let suffix = 2; taken.includes(id); suffix += 1) id = `${base}-${suffix}`;
  return id;
};

const targetOf = (connection: StoredConnection) =>
  connection.transport.type === "http"
    ? connection.transport.url
    : [connection.transport.command, ...connection.transport.args].join(" ");

const describeError = (cause: unknown) =>
  cause instanceof Error && cause.message ? cause.message : "The app did not respond.";

const failWith = (prefix: string) => (cause: unknown) =>
  new AppConnectionError({ message: `${prefix} ${describeError(cause)}` });

interface Connected {
  readonly client: McpConnection;
  readonly tools: ReadonlyArray<AppTool>;
}

const connect = (connection: StoredConnection, platform: NodeJS.Platform) =>
  Effect.tryPromise({
    try: async (signal) => {
      const client = await connectMcp(
        connection.transport,
        { signal, timeoutMs: CONNECT_TIMEOUT_MS },
        platform,
      );
      try {
        const tools: Array<AppTool> = [];
        let cursor: unknown;
        do {
          const page = await client.request(
            "tools/list",
            typeof cursor === "string" ? { cursor } : {},
            { signal, timeoutMs: CONNECT_TIMEOUT_MS },
          );
          for (const tool of Array.isArray(page.tools) ? page.tools : []) {
            if (typeof tool?.name !== "string") continue;
            tools.push({
              name: tool.name,
              description: typeof tool.description === "string" ? tool.description : "",
              inputSchema: tool.inputSchema,
            });
          }
          cursor = page.nextCursor;
        } while (typeof cursor === "string" && tools.length < 500);
        return { client, tools } satisfies Connected;
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
    },
    catch: failWith(`Could not connect to ${connection.name}.`),
  });

const closeClient = (connected: Connected) =>
  Effect.promise(() => connected.client.close().catch(() => undefined));

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const platform = yield* HostProcess.Platform;
  const writeLock = yield* Semaphore.make(1);
  // One shared connection attempt per app; a failed attempt is dropped so the next use retries.
  const clients = new Map<string, Effect.Effect<Connected, AppConnectionError>>();
  const errors = new Map<string, string>();

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...clients.values()],
      (connected) => connected.pipe(Effect.flatMap(closeClient), Effect.ignore),
      { concurrency: "unbounded", discard: true },
    ),
  );

  const read = secrets.get(SECRET_NAME).pipe(
    Effect.mapError(() => new AppConnectionError({ message: "Could not read connected apps." })),
    Effect.map(
      Option.match({
        onNone: (): ReadonlyArray<StoredConnection> => [],
        onSome: (bytes) => Option.getOrElse(decodeStored(decoder.decode(bytes)), () => []),
      }),
    ),
  );
  const write = (connections: ReadonlyArray<StoredConnection>) =>
    secrets
      .set(SECRET_NAME, encoder.encode(encodeStored(connections)))
      .pipe(
        Effect.mapError(
          () => new AppConnectionError({ message: "Could not save connected apps." }),
        ),
      );

  const forget = (id: string) =>
    Effect.gen(function* () {
      const existing = clients.get(id);
      clients.delete(id);
      errors.delete(id);
      if (existing) yield* existing.pipe(Effect.flatMap(closeClient), Effect.ignore);
    });

  const connected = (connection: StoredConnection) =>
    Effect.gen(function* () {
      let attempt = clients.get(connection.id);
      if (!attempt) {
        attempt = yield* Effect.cached(connect(connection, platform));
        clients.set(connection.id, attempt);
      }
      return yield* attempt.pipe(
        Effect.tap(() => Effect.sync(() => errors.delete(connection.id))),
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (clients.get(connection.id) === attempt) clients.delete(connection.id);
            errors.set(connection.id, error.message);
          }),
        ),
      );
    });

  const find = (id: string) =>
    read.pipe(
      Effect.flatMap((connections) => {
        const connection = connections.find((candidate) => candidate.id === id);
        return connection
          ? Effect.succeed(connection)
          : Effect.fail(
              new AppConnectionError({
                message: `No connected app "${id}". Call app_tools_list to see the connected apps.`,
              }),
            );
      }),
    );

  const summarize = (connection: StoredConnection) =>
    connected(connection).pipe(
      Effect.map(({ tools }): AppConnectionSummary => ({
        id: connection.id,
        name: connection.name,
        target: targetOf(connection),
        toolCount: tools.length,
        error: null,
      })),
      Effect.catch((error) =>
        Effect.succeed<AppConnectionSummary>({
          id: connection.id,
          name: connection.name,
          target: targetOf(connection),
          toolCount: null,
          error: error.message,
        }),
      ),
    );

  const list = read.pipe(
    Effect.flatMap((connections) =>
      Effect.forEach(connections, summarize, { concurrency: "unbounded" }),
    ),
    Effect.map((connections) => ({ connections })),
  );

  return AppConnections.of({
    list,
    add: (input) =>
      writeLock
        .withPermit(
          Effect.gen(function* () {
            const connections = yield* read;
            const connection: StoredConnection = {
              id: connectionIdFor(
                input.name,
                connections.map((existing) => existing.id),
              ),
              name: input.name,
              transport: input.transport,
            };
            const live = yield* connect(connection, platform);
            yield* write([...connections, connection]).pipe(
              Effect.tapError(() => closeClient(live)),
            );
            clients.set(connection.id, Effect.succeed(live));
          }),
        )
        .pipe(Effect.andThen(list), Effect.withSpan("AppConnections.add")),
    remove: (id) =>
      writeLock
        .withPermit(
          Effect.gen(function* () {
            const connections = yield* read;
            yield* write(connections.filter((connection) => connection.id !== id));
            yield* forget(id);
          }),
        )
        .pipe(Effect.andThen(list), Effect.withSpan("AppConnections.remove")),
    tools: (id) =>
      Effect.gen(function* () {
        const connections = id === undefined ? yield* read : [yield* find(id)];
        return yield* Effect.forEach(
          connections,
          (connection) =>
            connected(connection).pipe(
              Effect.map(({ tools }): AppTools => ({
                id: connection.id,
                name: connection.name,
                tools,
                error: null,
              })),
              Effect.catch((error) =>
                Effect.succeed<AppTools>({
                  id: connection.id,
                  name: connection.name,
                  tools: [],
                  error: error.message,
                }),
              ),
            ),
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.withSpan("AppConnections.tools")),
    call: (id, tool, args) =>
      Effect.gen(function* () {
        const connection = yield* find(id);
        const live = yield* connected(connection);
        if (!live.tools.some((candidate) => candidate.name === tool)) {
          return yield* new AppConnectionError({
            message: `${connection.name} has no tool "${tool}". Call app_tools_list with app "${id}" to see its tools.`,
          });
        }
        const result = yield* Effect.tryPromise({
          try: (signal) =>
            live.client.request(
              "tools/call",
              { name: tool, arguments: args },
              { signal, timeoutMs: CALL_TIMEOUT_MS },
            ),
          catch: failWith(`${connection.name} failed to run ${tool}.`),
        }).pipe(
          // A transport failure may mean the app went away; reconnect on next use.
          Effect.tapError(() => forget(id)),
        );
        return {
          content: result.content ?? [],
          ...(result.structuredContent === undefined
            ? {}
            : { structuredContent: result.structuredContent }),
          isError: result.isError === true,
        };
      }).pipe(Effect.withSpan("AppConnections.call")),
  });
});

export const layer = Layer.effect(AppConnections, make);
