import {
  AppConnectionAddInput,
  type AppConnectionAddResult,
  AppConnectionError,
  AppConnectionId,
  type AppConnectionList,
  type AppConnectionSignIn,
  type AppConnectionSignInResult,
  type AppConnectionSummary,
} from "@t3tools/contracts";
import { findAppPreset } from "@t3tools/shared/appCatalog";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  connectMcp,
  McpAuthorizationError,
  type McpAccessTokens,
  type McpConnection,
} from "./mcpClient.ts";
import * as McpOAuth from "./mcpOAuth.ts";

/**
 * Apps a user connected for their bots. Each app is an MCP server; MyBot
 * connects to it and relays its tools to every bot through the app_tools_list
 * and app_tool_call tools, so it works the same for every provider. Configs,
 * tokens, and OAuth client registrations live in the server secret store.
 */

const StoredConnection = Schema.Struct({
  id: AppConnectionId,
  name: Schema.String,
  presetId: Schema.optional(Schema.String),
  transport: AppConnectionAddInput.fields.transport,
});
type StoredConnection = typeof StoredConnection.Type;

const OAuthClient = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.optional(Schema.String),
  authMethod: Schema.Literals(["none", "client_secret_post", "client_secret_basic"]),
});

/** A connection's OAuth tokens and what refreshing them needs. */
const StoredTokens = Schema.Struct({
  tokenEndpoint: Schema.String,
  resource: Schema.String,
  client: OAuthClient,
  accessToken: Schema.String,
  refreshToken: Schema.NullOr(Schema.String),
  /** Epoch milliseconds, when the server said how long the token lasts. */
  expiresAt: Schema.NullOr(Schema.Number),
});
type StoredTokens = typeof StoredTokens.Type;

/** Secret names: connections, tokens by connection id, and registered clients by issuer and redirect URI. */
const CONNECTIONS_SECRET = "app-connections";
const TOKENS_SECRET = "app-connection-tokens";
const CLIENTS_SECRET = "app-oauth-clients";

const ConnectionsJson = Schema.fromJsonString(Schema.Array(StoredConnection));
const TokensJson = Schema.fromJsonString(Schema.Record(Schema.String, StoredTokens));
const ClientsJson = Schema.fromJsonString(Schema.Record(Schema.String, OAuthClient));

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 5 * 60_000;
const SIGN_IN_TTL_MS = 10 * 60_000;
/** Refresh a little before the server's expiry, so a request does not race it. */
const EXPIRY_SKEW_MS = 60_000;
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

/** The query parameters an authorization server returns to the sign-in callback. */
export interface AppSignInCallback {
  readonly state?: string | undefined;
  readonly code?: string | undefined;
  readonly error?: string | undefined;
}

export class AppConnections extends Context.Service<
  AppConnections,
  {
    readonly list: Effect.Effect<AppConnectionList, AppConnectionError>;
    /**
     * Connects to the app first, so a wrong URL or command is reported
     * instead of saved. An app that asks for sign-in is saved and returns
     * where the user signs in.
     */
    readonly add: (
      input: AppConnectionAddInput,
    ) => Effect.Effect<AppConnectionAddResult, AppConnectionError>;
    readonly remove: (id: string) => Effect.Effect<AppConnectionList, AppConnectionError>;
    /** Starts browser sign-in again for a connected app. */
    readonly signIn: (
      id: string,
      redirectBaseUrl: string,
    ) => Effect.Effect<AppConnectionSignInResult, AppConnectionError>;
    /** Finishes a sign-in from its callback; returns the app's name. */
    readonly completeSignIn: (
      callback: AppSignInCallback,
    ) => Effect.Effect<string, AppConnectionError>;
    /** Every app's tools, or one app's. */
    readonly tools: (id?: string) => Effect.Effect<ReadonlyArray<AppTools>, AppConnectionError>;
    readonly call: (
      id: string,
      tool: string,
      args: Record<string, unknown>,
    ) => Effect.Effect<AppToolResult, AppConnectionError>;
  }
>()("t3/apps/AppConnections") {}

/** The app refused MyBot until the user signs in (again). */
class AppNeedsSignIn extends Schema.TaggedError<AppNeedsSignIn>()("AppNeedsSignIn", {
  message: Schema.String,
  wwwAuthenticate: Schema.NullOr(Schema.String),
}) {}

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

/** Where the app runs, without secrets: a URL's host, or a command without its arguments. */
export const targetOf = (connection: StoredConnection): string => {
  const where =
    connection.transport.type === "stdio"
      ? connection.transport.command
      : URL.canParse(connection.transport.url)
        ? new URL(connection.transport.url).host
        : "web app";
  const preset = connection.presetId ? findAppPreset(connection.presetId) : undefined;
  return preset && preset.name !== connection.name ? `${preset.name} · ${where}` : where;
};

/** HTTP apps without a fixed token may sign in through the browser. */
const usesSignIn = (connection: StoredConnection) =>
  connection.transport.type === "http" &&
  connection.transport.auth !== "token" &&
  !connection.transport.bearerToken;

const needsSignInMessage = (name: string) =>
  `${name} needs the user to sign in again in Settings → Apps.`;

const describeError = (cause: unknown) =>
  cause instanceof Error && cause.message ? cause.message : "The app did not respond.";

const failWith =
  (connection: StoredConnection, prefix: string) =>
  (cause: unknown): AppConnectionError | AppNeedsSignIn =>
    cause instanceof McpAuthorizationError && usesSignIn(connection)
      ? new AppNeedsSignIn({
          message: needsSignInMessage(connection.name),
          wwwAuthenticate: cause.wwwAuthenticate,
        })
      : new AppConnectionError({ message: `${prefix} ${describeError(cause)}` });

const asConnectionError = (error: AppConnectionError | AppNeedsSignIn) =>
  error._tag === "AppNeedsSignIn" ? new AppConnectionError({ message: error.message }) : error;

interface Connected {
  readonly client: McpConnection;
  readonly tools: ReadonlyArray<AppTool>;
}

interface PendingSignIn {
  readonly connectionId: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly tokenEndpoint: string;
  readonly resource: string;
  readonly client: typeof OAuthClient.Type;
  readonly expiresAt: number;
}

const connect = (
  connection: StoredConnection,
  platform: NodeJS.Platform,
  accessTokens: McpAccessTokens | undefined,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const client = await connectMcp(
        connection.transport.type === "http"
          ? { ...connection.transport, accessTokens }
          : connection.transport,
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
    catch: failWith(connection, `Could not connect to ${connection.name}.`),
  });

const closeClient = (connected: Connected) =>
  Effect.promise(() => connected.client.close().catch(() => undefined));

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const platform = yield* HostProcess.Platform;
  const services = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(services);
  const writeLock = yield* Semaphore.make(1);
  const tokenLock = yield* Semaphore.make(1);
  // One shared connection attempt per app; a failed attempt is dropped so the next use retries.
  const clients = new Map<string, Effect.Effect<Connected, AppConnectionError | AppNeedsSignIn>>();
  // Sign-ins waiting for their callback, by `state`. In memory: a restart just means signing in again.
  const pending = new Map<string, PendingSignIn>();
  const refreshing = new Map<string, Promise<string | undefined>>();

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...clients.values()],
      (connected) => connected.pipe(Effect.flatMap(closeClient), Effect.ignore),
      { concurrency: "unbounded", discard: true },
    ),
  );

  const readSecret = <A>(name: string, schema: Schema.Codec<A, string>, empty: A) =>
    secrets.get(name).pipe(
      Effect.mapError(() => new AppConnectionError({ message: "Could not read connected apps." })),
      Effect.map(
        Option.match({
          onNone: () => empty,
          onSome: (bytes) =>
            Option.getOrElse(
              Schema.decodeUnknownOption(schema)(decoder.decode(bytes)),
              () => empty,
            ),
        }),
      ),
    );
  const writeSecret = <A>(name: string, schema: Schema.Codec<A, string>, value: A) =>
    secrets
      .set(name, encoder.encode(Schema.encodeSync(schema)(value)))
      .pipe(
        Effect.mapError(
          () => new AppConnectionError({ message: "Could not save connected apps." }),
        ),
      );

  const read = readSecret(CONNECTIONS_SECRET, ConnectionsJson, []);
  const write = (connections: ReadonlyArray<StoredConnection>) =>
    writeSecret(CONNECTIONS_SECRET, ConnectionsJson, connections);
  const readTokens = readSecret(TOKENS_SECRET, TokensJson, {});
  const updateTokens = (
    update: (
      tokens: Readonly<Record<string, StoredTokens>>,
    ) => Readonly<Record<string, StoredTokens>>,
  ) =>
    tokenLock.withPermit(
      readTokens.pipe(
        Effect.flatMap((tokens) => writeSecret(TOKENS_SECRET, TokensJson, update(tokens))),
      ),
    );
  const dropTokens = (id: string) => updateTokens(({ [id]: _dropped, ...rest }) => rest);

  const expiresAtFor = (expiresIn: number | null) =>
    expiresIn === null
      ? Effect.succeed(null)
      : Clock.currentTimeMillis.pipe(Effect.map((now) => now + expiresIn * 1000));

  /** Exchanges the refresh token; undefined when the user must sign in again. */
  const refreshAccess = (id: string) =>
    Effect.gen(function* () {
      const stored = (yield* readTokens)[id];
      if (!stored?.refreshToken) {
        if (stored) yield* dropTokens(id);
        return undefined;
      }
      const refreshToken = stored.refreshToken;
      const fresh = yield* Effect.tryPromise({
        try: (signal) =>
          McpOAuth.refreshTokens(
            {
              tokenEndpoint: stored.tokenEndpoint,
              client: stored.client,
              refreshToken,
              resource: stored.resource,
            },
            AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]),
          ),
        catch: (cause) =>
          cause instanceof McpOAuth.OAuthRejectedError
            ? new AppNeedsSignIn({ message: cause.message, wwwAuthenticate: null })
            : new AppConnectionError({
                message: `Could not refresh the sign-in. ${describeError(cause)}`,
              }),
      }).pipe(
        Effect.asSome,
        Effect.catchTags({ AppNeedsSignIn: () => Effect.as(dropTokens(id), Option.none()) }),
      );
      if (Option.isNone(fresh)) return undefined;
      const expiresAt = yield* expiresAtFor(fresh.value.expiresIn);
      yield* updateTokens((tokens) => ({
        ...tokens,
        [id]: {
          ...stored,
          accessToken: fresh.value.accessToken,
          refreshToken: fresh.value.refreshToken ?? refreshToken,
          expiresAt,
        },
      }));
      return fresh.value.accessToken;
    }).pipe(Effect.withSpan("AppConnections.refreshAccess"));

  const accessTokensFor = (id: string): McpAccessTokens => {
    // Concurrent requests share one refresh, so a rotating refresh token is used once.
    const refresh = () => {
      let attempt = refreshing.get(id);
      if (!attempt) {
        attempt = runPromise(refreshAccess(id)).finally(() => refreshing.delete(id));
        refreshing.set(id, attempt);
      }
      return attempt;
    };
    return {
      token: async () => {
        const { stored, now } = await runPromise(
          Effect.all({
            stored: readTokens.pipe(Effect.map((tokens) => tokens[id])),
            now: Clock.currentTimeMillis,
          }),
        );
        if (!stored) return undefined;
        const expired = stored.expiresAt !== null && stored.expiresAt - EXPIRY_SKEW_MS <= now;
        return expired && stored.refreshToken ? refresh() : stored.accessToken;
      },
      refresh,
    };
  };

  const forget = (id: string) =>
    Effect.gen(function* () {
      const existing = clients.get(id);
      clients.delete(id);
      if (existing) yield* existing.pipe(Effect.flatMap(closeClient), Effect.ignore);
    });

  const connectTo = (connection: StoredConnection) =>
    connect(
      connection,
      platform,
      usesSignIn(connection) ? accessTokensFor(connection.id) : undefined,
    );

  const connected = (connection: StoredConnection) =>
    Effect.gen(function* () {
      let attempt = clients.get(connection.id);
      if (!attempt) {
        attempt = yield* Effect.cached(connectTo(connection));
        clients.set(connection.id, attempt);
      }
      const current = attempt;
      return yield* current.pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            if (clients.get(connection.id) === current) clients.delete(connection.id);
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

  /** Registers MyBot with the app's authorization server if needed and returns where to sign in. */
  const beginSignIn = (
    connection: StoredConnection,
    redirectBaseUrl: string | undefined,
    wwwAuthenticate: string | null | undefined,
  ) =>
    Effect.gen(function* () {
      if (connection.transport.type !== "http" || !usesSignIn(connection)) {
        return yield* new AppConnectionError({
          message: `${connection.name} does not sign in through the browser.`,
        });
      }
      const url = connection.transport.url;
      const redirectUri =
        redirectBaseUrl === undefined ? null : McpOAuth.appSignInRedirectUri(redirectBaseUrl);
      if (redirectUri === null) {
        return yield* new AppConnectionError({
          message: `${connection.name} needs you to sign in, but MyBot could not tell where your browser should return.`,
        });
      }
      const fail = (cause: unknown) =>
        new AppConnectionError({
          message: `Could not start signing in to ${connection.name}. ${describeError(cause)}`,
        });
      const discovery = yield* Effect.tryPromise({
        try: (signal) =>
          McpOAuth.discoverOAuth(
            url,
            wwwAuthenticate,
            AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]),
          ),
        catch: fail,
      });
      const clientKey = `${discovery.server.issuer} ${redirectUri}`;
      const registered = (yield* readSecret(CLIENTS_SECRET, ClientsJson, {}))[clientKey];
      const client =
        registered ??
        (yield* Effect.tryPromise({
          try: (signal) =>
            McpOAuth.registerClient(
              discovery.server,
              redirectUri,
              AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]),
            ),
          catch: fail,
        }).pipe(
          Effect.tap((created) =>
            tokenLock.withPermit(
              readSecret(CLIENTS_SECRET, ClientsJson, {}).pipe(
                Effect.flatMap((clients) =>
                  writeSecret(CLIENTS_SECRET, ClientsJson, { ...clients, [clientKey]: created }),
                ),
              ),
            ),
          ),
        ));
      const now = yield* Clock.currentTimeMillis;
      for (const [state, entry] of pending) if (entry.expiresAt <= now) pending.delete(state);
      const state = McpOAuth.randomToken();
      const verifier = McpOAuth.randomToken();
      pending.set(state, {
        connectionId: connection.id,
        verifier,
        redirectUri,
        tokenEndpoint: discovery.server.tokenEndpoint,
        resource: discovery.resource,
        client,
        expiresAt: now + SIGN_IN_TTL_MS,
      });
      return McpOAuth.authorizationUrl({ discovery, client, redirectUri, verifier, state });
    });

  const summarize = (connection: StoredConnection) =>
    connected(connection).pipe(
      Effect.map(({ tools }): AppConnectionSummary => ({
        id: connection.id,
        name: connection.name,
        presetId: connection.presetId ?? null,
        target: targetOf(connection),
        status: "ready",
        toolCount: tools.length,
        error: null,
      })),
      Effect.catch((error) =>
        Effect.succeed<AppConnectionSummary>({
          id: connection.id,
          name: connection.name,
          presetId: connection.presetId ?? null,
          target: targetOf(connection),
          status: error._tag === "AppNeedsSignIn" ? "needs-sign-in" : "error",
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

  const signInMessage = "Start signing in again from Settings → Apps.";

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
              ...(input.presetId ? { presetId: input.presetId } : {}),
              transport: input.transport,
            };
            const outcome = yield* connectTo(connection).pipe(
              Effect.map((live) => ({ live, wwwAuthenticate: null })),
              Effect.catchTags({
                AppNeedsSignIn: (error) =>
                  Effect.succeed({ live: null, wwwAuthenticate: error.wwwAuthenticate }),
              }),
            );
            if (outcome.live) {
              const live = outcome.live;
              yield* write([...connections, connection]).pipe(
                Effect.tapError(() => closeClient(live)),
              );
              clients.set(connection.id, Effect.succeed(live));
              return undefined;
            }
            const authorizationUrl = yield* beginSignIn(
              connection,
              input.redirectBaseUrl,
              outcome.wwwAuthenticate,
            );
            yield* write([...connections, connection]);
            return { connectionId: connection.id, authorizationUrl } satisfies AppConnectionSignIn;
          }),
        )
        .pipe(
          Effect.flatMap((signIn) =>
            list.pipe(
              Effect.map((result): AppConnectionAddResult =>
                signIn ? { ...result, signIn } : result,
              ),
            ),
          ),
          Effect.withSpan("AppConnections.add"),
        ),
    remove: (id) =>
      writeLock
        .withPermit(
          Effect.gen(function* () {
            const connections = yield* read;
            yield* write(connections.filter((connection) => connection.id !== id));
            yield* dropTokens(id);
            for (const [state, entry] of pending)
              if (entry.connectionId === id) pending.delete(state);
            yield* forget(id);
          }),
        )
        .pipe(Effect.andThen(list), Effect.withSpan("AppConnections.remove")),
    signIn: (id, redirectBaseUrl) =>
      find(id).pipe(
        Effect.flatMap((connection) => beginSignIn(connection, redirectBaseUrl, undefined)),
        Effect.map((authorizationUrl) => ({ authorizationUrl })),
        Effect.withSpan("AppConnections.signIn"),
      ),
    completeSignIn: (callback) =>
      Effect.gen(function* () {
        const entry = callback.state ? pending.get(callback.state) : undefined;
        if (!entry || !callback.state) {
          return yield* new AppConnectionError({
            message: `This sign-in link is not valid or was already used. ${signInMessage}`,
          });
        }
        // Single use, whatever happens next.
        pending.delete(callback.state);
        if (entry.expiresAt <= (yield* Clock.currentTimeMillis)) {
          return yield* new AppConnectionError({
            message: `This sign-in link expired. ${signInMessage}`,
          });
        }
        const connection = yield* find(entry.connectionId).pipe(
          Effect.mapError(
            () =>
              new AppConnectionError({ message: "The app was removed before sign-in finished." }),
          ),
        );
        if (callback.error !== undefined || !callback.code) {
          const reason = callback.error?.replace(/[^\w.-]/g, "").slice(0, 60);
          return yield* new AppConnectionError({
            message: `${connection.name} did not finish signing in${reason ? ` (${reason})` : ""}. ${signInMessage}`,
          });
        }
        const code = callback.code;
        const tokens = yield* Effect.tryPromise({
          try: (signal) =>
            McpOAuth.exchangeCode(
              {
                tokenEndpoint: entry.tokenEndpoint,
                client: entry.client,
                code,
                verifier: entry.verifier,
                redirectUri: entry.redirectUri,
                resource: entry.resource,
              },
              AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]),
            ),
          catch: (cause) =>
            new AppConnectionError({
              message: `Could not finish signing in to ${connection.name}. ${describeError(cause)}`,
            }),
        });
        const expiresAt = yield* expiresAtFor(tokens.expiresIn);
        yield* updateTokens((stored) => ({
          ...stored,
          [connection.id]: {
            tokenEndpoint: entry.tokenEndpoint,
            resource: entry.resource,
            client: entry.client,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt,
          },
        }));
        yield* forget(connection.id);
        yield* connected(connection).pipe(
          Effect.mapError(
            (error) =>
              new AppConnectionError({
                message: `Signed in to ${connection.name}, but it did not connect. ${error.message}`,
              }),
          ),
        );
        return connection.name;
      }).pipe(Effect.withSpan("AppConnections.completeSignIn")),
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
        const live = yield* connected(connection).pipe(Effect.mapError(asConnectionError));
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
          catch: failWith(connection, `${connection.name} failed to run ${tool}.`),
        }).pipe(
          // A transport failure may mean the app went away; reconnect on next use.
          Effect.tapError(() => forget(id)),
          Effect.mapError(asConnectionError),
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
