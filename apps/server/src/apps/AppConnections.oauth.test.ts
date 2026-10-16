// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as AppConnections from "./AppConnections.ts";
import * as LocalRuntimes from "./LocalRuntimes.ts";

const REDIRECT_BASE = "http://127.0.0.1:3773";
const CALLBACK = `${REDIRECT_BASE}/oauth/apps/callback`;

interface IssuedCode {
  readonly challenge: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly resource: string;
}

/**
 * An MCP echo app behind OAuth and its authorization server, on one origin:
 * protected resource metadata, authorization server metadata, dynamic client
 * registration, and a token endpoint that checks PKCE and rotates refresh tokens.
 */
class FakeOAuthApp {
  origin = "";
  readonly accessTokens = new Set<string>(["static-token"]);
  readonly refreshTokens = new Set<string>();
  readonly codes = new Map<string, IssuedCode>();
  registrations = 0;
  refreshes = 0;
  rejectRefresh = false;
  /** expires_in for tokens from a code; refreshed tokens last an hour. */
  codeTokenLifetime = 3600;
  private issued = 0;

  get url() {
    return `${this.origin}/mcp`;
  }

  /** Plays the user approving sign-in at the authorization URL; returns the callback parameters. */
  authorize(authorizationUrl: string) {
    const params = new URL(authorizationUrl).searchParams;
    const code = `code-${++this.issued}`;
    this.codes.set(code, {
      challenge: params.get("code_challenge") ?? "",
      redirectUri: params.get("redirect_uri") ?? "",
      clientId: params.get("client_id") ?? "",
      resource: params.get("resource") ?? "",
    });
    return { state: params.get("state") ?? "", code };
  }

  revokeAccessTokens() {
    for (const token of this.accessTokens)
      if (token !== "static-token") this.accessTokens.delete(token);
  }

  private issue(lifetime: number) {
    const n = ++this.issued;
    this.accessTokens.add(`access-${n}`);
    this.refreshTokens.add(`refresh-${n}`);
    return {
      access_token: `access-${n}`,
      token_type: "Bearer",
      refresh_token: `refresh-${n}`,
      expires_in: lifetime,
    };
  }

  token(form: URLSearchParams): [number, unknown] {
    if (form.get("grant_type") === "authorization_code") {
      const issued = this.codes.get(form.get("code") ?? "");
      this.codes.delete(form.get("code") ?? "");
      const challenge = NodeCrypto.createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (
        !issued ||
        issued.challenge !== challenge ||
        issued.redirectUri !== form.get("redirect_uri") ||
        issued.clientId !== form.get("client_id") ||
        issued.resource !== form.get("resource")
      ) {
        return [400, { error: "invalid_grant" }];
      }
      return [200, this.issue(this.codeTokenLifetime)];
    }
    const refreshToken = form.get("refresh_token") ?? "";
    if (this.rejectRefresh || !this.refreshTokens.delete(refreshToken)) {
      return [400, { error: "invalid_grant" }];
    }
    this.refreshes += 1;
    return [200, this.issue(3600)];
  }

  async handle(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) {
    const path = new URL(request.url ?? "/", this.origin).pathname;
    const json = (status: number, body: unknown) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const readBody = async () => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      return body;
    };
    if (path === "/.well-known/oauth-protected-resource/mcp") {
      return json(200, {
        resource: this.url,
        authorization_servers: [`${this.origin}/as`],
        scopes_supported: ["tools"],
      });
    }
    if (path === "/.well-known/oauth-authorization-server/as") {
      return json(200, {
        issuer: `${this.origin}/as`,
        authorization_endpoint: `${this.origin}/as/authorize`,
        token_endpoint: `${this.origin}/as/token`,
        registration_endpoint: `${this.origin}/as/register`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (path === "/as/register") {
      const body = JSON.parse(await readBody());
      expect(body).toMatchObject({ client_name: "MyBot", token_endpoint_auth_method: "none" });
      this.registrations += 1;
      return json(201, { client_id: "client-1", redirect_uris: body.redirect_uris });
    }
    if (path === "/as/token") {
      const [status, body] = this.token(new URLSearchParams(await readBody()));
      return json(status, body);
    }
    if (path !== "/mcp") return json(404, {});
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    if (!token || !this.accessTokens.has(token)) {
      response
        .writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end();
      return;
    }
    const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "echo", inputSchema: { type: "object" } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => ({
      content: [{ type: "text", text: `echo: ${String(call.params.arguments?.text)}` }],
    }));
    const transport = new StreamableHTTPServerTransport({});
    await server.connect(transport as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(request, response);
  }
}

const startFakeOAuthApp = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ app: FakeOAuthApp; server: NodeHttp.Server }>((resolve) => {
        const app = new FakeOAuthApp();
        const server = NodeHttp.createServer((request, response) => {
          void app.handle(request, response);
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          app.origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
          resolve({ app, server });
        });
      }),
  ),
  ({ server }) =>
    Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
).pipe(Effect.map(({ app }) => app));

/** Runs `effect` with the clock moved forward by `ms`. */
const later =
  (ms: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.clockWith((clock) =>
      Effect.provideService(effect, Clock.Clock, {
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + ms,
        currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() + ms),
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe() + BigInt(ms) * 1_000_000n,
        currentTimeNanos: Effect.sync(
          () => clock.currentTimeNanosUnsafe() + BigInt(ms) * 1_000_000n,
        ),
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        sleep: (duration) => clock.sleep(duration),
      }),
    );

const layerTest = AppConnections.layer.pipe(
  Layer.provideMerge(LocalRuntimes.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-app-oauth-" })),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(NodeServices.layer),
);

describe("AppConnections OAuth", () => {
  it.live("signs in through the browser, refreshes tokens, and asks to sign in again", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeOAuthApp;
      const apps = yield* AppConnections.AppConnections;

      const added = yield* apps.add({
        name: "Secure Echo",
        transport: { type: "http", url: fake.url },
        redirectBaseUrl: `${REDIRECT_BASE}/settings`,
      });
      expect(added.signIn?.connectionId).toBe("secure-echo");
      const authorizationUrl = new URL(added.signIn?.authorizationUrl ?? "");
      expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
        `${fake.origin}/as/authorize`,
      );
      expect(Object.fromEntries(authorizationUrl.searchParams)).toEqual({
        response_type: "code",
        client_id: "client-1",
        redirect_uri: CALLBACK,
        code_challenge: expect.stringMatching(/^[\w-]{43}$/),
        code_challenge_method: "S256",
        state: expect.stringMatching(/^[\w-]{43}$/),
        resource: fake.url,
        scope: "tools",
      });
      expect(added.connections).toEqual([
        expect.objectContaining({
          id: "secure-echo",
          status: "needs-sign-in",
          toolCount: null,
          target: new URL(fake.origin).host,
        }),
      ]);

      const callback = fake.authorize(authorizationUrl.href);
      expect(yield* apps.completeSignIn(callback)).toBe("Secure Echo");
      const reused = yield* apps.completeSignIn(callback).pipe(Effect.flip);
      expect(reused.message).toContain("not valid or was already used");
      expect((yield* apps.list).connections).toEqual([
        expect.objectContaining({ id: "secure-echo", status: "ready", toolCount: 1, error: null }),
      ]);
      const echoed = yield* apps.call("secure-echo", "echo", { text: "hi" });
      expect(echoed.content).toEqual([{ type: "text", text: "echo: hi" }]);

      // The app revokes the access token early: MyBot refreshes once and retries.
      fake.revokeAccessTokens();
      const refreshed = yield* apps.call("secure-echo", "echo", { text: "again" });
      expect(refreshed.content).toEqual([{ type: "text", text: "echo: again" }]);
      expect(fake.refreshes).toBe(1);

      // The refresh token is refused too: the app needs sign-in, and stays connected.
      fake.rejectRefresh = true;
      fake.revokeAccessTokens();
      const refused = yield* apps.call("secure-echo", "echo", { text: "no" }).pipe(Effect.flip);
      expect(refused.message).toBe(
        "Secure Echo needs the user to sign in again in Settings → Apps.",
      );
      expect((yield* apps.list).connections).toEqual([
        expect.objectContaining({ id: "secure-echo", status: "needs-sign-in" }),
      ]);
      const [tools] = yield* apps.tools("secure-echo");
      expect(tools?.error).toContain("needs the user to sign in again");

      // Signing in again reuses the registered client.
      fake.rejectRefresh = false;
      const again = yield* apps.signIn("secure-echo", REDIRECT_BASE);
      expect(fake.registrations).toBe(1);
      yield* apps.completeSignIn(fake.authorize(again.authorizationUrl));
      expect((yield* apps.list).connections).toEqual([
        expect.objectContaining({ id: "secure-echo", status: "ready", toolCount: 1 }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("refreshes a token that is about to expire before using it", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeOAuthApp;
      fake.codeTokenLifetime = 30;
      const apps = yield* AppConnections.AppConnections;
      const added = yield* apps.add({
        name: "Short Lived",
        transport: { type: "http", url: fake.url, auth: "oauth" },
        redirectBaseUrl: REDIRECT_BASE,
      });
      yield* apps.completeSignIn(fake.authorize(added.signIn?.authorizationUrl ?? ""));
      expect(fake.refreshes).toBe(1);
      expect((yield* apps.list).connections).toEqual([
        expect.objectContaining({ status: "ready", toolCount: 1 }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("rejects unknown, expired, and misdirected sign-ins", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeOAuthApp;
      const apps = yield* AppConnections.AppConnections;

      const noRedirect = yield* apps
        .add({ name: "Echo", transport: { type: "http", url: fake.url } })
        .pipe(Effect.flip);
      expect(noRedirect.message).toContain("could not tell where your browser should return");
      expect((yield* apps.list).connections).toEqual([]);

      const added = yield* apps.add({
        name: "Echo",
        transport: { type: "http", url: fake.url },
        redirectBaseUrl: REDIRECT_BASE,
      });
      const badBase = yield* apps.signIn("echo", "javascript:alert(1)").pipe(Effect.flip);
      expect(badBase.message).toContain("could not tell where your browser should return");

      const callback = fake.authorize(added.signIn?.authorizationUrl ?? "");
      const unknown = yield* apps
        .completeSignIn({ state: "made-up", code: callback.code })
        .pipe(Effect.flip);
      expect(unknown.message).toContain("not valid");
      const expired = yield* apps.completeSignIn(callback).pipe(later(11 * 60_000), Effect.flip);
      expect(expired.message).toContain("expired");
      const used = yield* apps.completeSignIn(callback).pipe(Effect.flip);
      expect(used.message).toContain("not valid or was already used");

      const denied = yield* apps.signIn("echo", REDIRECT_BASE);
      const { state } = fake.authorize(denied.authorizationUrl);
      const cancelled = yield* apps
        .completeSignIn({ state, error: "access_denied" })
        .pipe(Effect.flip);
      expect(cancelled.message).toContain("Echo did not finish signing in (access_denied)");
      expect((yield* apps.list).connections).toEqual([
        expect.objectContaining({ id: "echo", status: "needs-sign-in" }),
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("never shows tokens or URL secrets in summaries", () =>
    Effect.gen(function* () {
      const fake = yield* startFakeOAuthApp;
      const apps = yield* AppConnections.AppConnections;
      const added = yield* apps.add({
        name: "Keyed",
        presetId: "telnyx",
        transport: {
          type: "http",
          url: `${fake.url}?key=hidden-key`,
          bearerToken: "static-token",
          auth: "token",
        },
      });
      expect(added.signIn).toBeUndefined();
      expect(added.connections).toEqual([
        expect.objectContaining({
          status: "ready",
          target: `Telnyx · ${new URL(fake.origin).host}`,
        }),
      ]);
      const shown = JSON.stringify(added);
      expect(shown).not.toContain("hidden-key");
      expect(shown).not.toContain("static-token");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
