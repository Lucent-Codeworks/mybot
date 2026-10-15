// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// Promise-based like mcpClient.ts, so it runs inside Effect.tryPromise with that fiber's abort signal.
import * as NodeCrypto from "node:crypto";

/**
 * Browser sign-in for HTTP apps, following the MCP authorization spec
 * (2025-06-18): protected resource metadata (RFC 9728), authorization server
 * metadata (RFC 8414, or OpenID discovery), dynamic client registration
 * (RFC 7591), and the authorization code flow with PKCE (S256) and a
 * `resource` indicator (RFC 8707). Dependency-free for the same reason as
 * mcpClient.ts. Errors never carry tokens, codes, or response bodies.
 */

/** Where an app's sign-in returns to on this server. */
export const APP_SIGN_IN_CALLBACK_PATH = "/oauth/apps/callback";

const PROTOCOL_VERSION = "2025-06-18";

export interface OAuthServer {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string | null;
}

export interface OAuthDiscovery {
  readonly server: OAuthServer;
  /** The `resource` to request tokens for: the MCP server. */
  readonly resource: string;
  readonly scope: string | null;
}

export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly authMethod: "none" | "client_secret_post" | "client_secret_basic";
}

export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** Seconds the access token lasts, when the server says. */
  readonly expiresIn: number | null;
}

/** The authorization server refused a code or refresh token; the user must sign in again. */
export class OAuthRejectedError extends Error {}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const stringOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const isHttpUrl = (value: string | null): value is string => {
  if (value === null || !URL.canParse(value)) return false;
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
};

/**
 * The callback URL for a client-reported server origin, such as
 * `http://localhost:3773`, or null when it is not an http(s) URL.
 */
export function appSignInRedirectUri(redirectBaseUrl: string): string | null {
  if (!URL.canParse(redirectBaseUrl)) return null;
  const base = new URL(redirectBaseUrl);
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.username || base.password) {
    return null;
  }
  return new URL(APP_SIGN_IN_CALLBACK_PATH, base.origin).href;
}

/** The `resource_metadata` and `scope` parameters of a `WWW-Authenticate: Bearer` challenge. */
export function parseWwwAuthenticate(header: string | null | undefined): {
  readonly resourceMetadata: string | null;
  readonly scope: string | null;
} {
  const params = new Map<string, string>();
  if (header && /^\s*bearer\b/i.test(header)) {
    for (const match of header.matchAll(
      /([a-z_][a-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/gi,
    )) {
      const key = match[1]?.toLowerCase();
      const value = match[2]?.replace(/\\(.)/g, "$1") ?? match[3];
      if (key && value !== undefined && !params.has(key)) params.set(key, value);
    }
  }
  return {
    resourceMetadata: params.get("resource_metadata") ?? null,
    scope: params.get("scope") ?? null,
  };
}

/** JSON from `url`, or null when it is missing or not a JSON object. */
async function getJson(url: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    return asRecord(await response.json());
  } catch {
    return null;
  }
}

async function firstJson(urls: ReadonlyArray<string>, signal: AbortSignal) {
  for (const url of urls) {
    const json = await getJson(url, signal);
    if (json) return json;
  }
  return null;
}

/** Well-known URLs for `suffix` on `url`'s origin: with the path inserted (RFC 8414/9728), then at the root. */
function wellKnown(url: URL, suffix: string): Array<string> {
  const path = url.pathname.replace(/\/+$/, "");
  const root = new URL(`/.well-known/${suffix}`, url.origin).href;
  return path ? [new URL(`/.well-known/${suffix}${path}`, url.origin).href, root] : [root];
}

/** Asks the app without credentials, for its `WWW-Authenticate` challenge. */
async function probe(serverUrl: string, signal: AbortSignal): Promise<string | null> {
  const response = await fetch(serverUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "mybot", version: "1.0.0" },
      },
    }),
    signal,
  });
  await response.body?.cancel().catch(() => undefined);
  return response.status === 401 ? response.headers.get("www-authenticate") : null;
}

async function authorizationServerMetadata(
  issuer: string,
  signal: AbortSignal,
): Promise<OAuthServer | null> {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  const candidates = path
    ? [
        new URL(`/.well-known/oauth-authorization-server${path}`, url.origin).href,
        new URL(`/.well-known/openid-configuration${path}`, url.origin).href,
        new URL(`${path}/.well-known/openid-configuration`, url.origin).href,
      ]
    : [
        new URL("/.well-known/oauth-authorization-server", url.origin).href,
        new URL("/.well-known/openid-configuration", url.origin).href,
      ];
  const metadata = await firstJson(candidates, signal);
  if (!metadata) return null;
  const authorizationEndpoint = stringOf(metadata.authorization_endpoint);
  const tokenEndpoint = stringOf(metadata.token_endpoint);
  if (!isHttpUrl(authorizationEndpoint) || !isHttpUrl(tokenEndpoint)) return null;
  const methods = metadata.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) {
    throw new Error("This app's sign-in does not support PKCE, which MyBot requires.");
  }
  const registrationEndpoint = stringOf(metadata.registration_endpoint);
  return {
    issuer: stringOf(metadata.issuer) ?? issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: isHttpUrl(registrationEndpoint) ? registrationEndpoint : null,
  };
}

/**
 * Finds how to sign in to the MCP server at `serverUrl`. `wwwAuthenticate`
 * is the challenge from a refused request; without it, the app is asked again.
 */
export async function discoverOAuth(
  serverUrl: string,
  wwwAuthenticate: string | null | undefined,
  signal: AbortSignal,
): Promise<OAuthDiscovery> {
  const server = new URL(serverUrl);
  const challenge = parseWwwAuthenticate(
    wwwAuthenticate === undefined ? await probe(serverUrl, signal) : wwwAuthenticate,
  );
  const metadataUrls = [
    ...(isHttpUrl(challenge.resourceMetadata) ? [challenge.resourceMetadata] : []),
    ...wellKnown(server, "oauth-protected-resource"),
  ];
  const resourceMetadata = await firstJson(metadataUrls, signal);
  const issuers = Array.isArray(resourceMetadata?.authorization_servers)
    ? resourceMetadata.authorization_servers.filter((issuer): issuer is string =>
        isHttpUrl(stringOf(issuer)),
      )
    : [];
  // Servers from before protected resource metadata act as their own authorization server.
  const issuer = issuers[0] ?? server.origin;
  const metadata = await authorizationServerMetadata(issuer, signal);
  if (!metadata) throw new Error("This app does not say how to sign in to it.");

  const advertised = stringOf(resourceMetadata?.resource);
  // The resource must name this server; prefer the app's own spelling of it.
  const resource =
    advertised && isHttpUrl(advertised) && serverUrl.startsWith(advertised.replace(/\/+$/, ""))
      ? advertised
      : `${server.origin}${server.pathname}${server.search}`;
  const scopes = Array.isArray(resourceMetadata?.scopes_supported)
    ? resourceMetadata.scopes_supported.filter((scope) => typeof scope === "string")
    : [];
  return {
    server: metadata,
    resource,
    scope: challenge.scope ?? (scopes.length > 0 ? scopes.join(" ") : null),
  };
}

/** Registers MyBot as a public client of the authorization server. */
export async function registerClient(
  server: OAuthServer,
  redirectUri: string,
  signal: AbortSignal,
): Promise<OAuthClient> {
  if (!server.registrationEndpoint) {
    throw new Error("This app needs a client ID; it does not support automatic sign-in.");
  }
  const response = await fetch(server.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "MyBot",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal,
  });
  const body = response.ok ? asRecord(await response.json().catch(() => null)) : null;
  if (!response.ok) await response.body?.cancel().catch(() => undefined);
  const clientId = stringOf(body?.client_id);
  if (!body || !clientId) {
    throw new Error(`The app's sign-in did not register MyBot (HTTP ${response.status}).`);
  }
  const clientSecret = stringOf(body.client_secret) ?? undefined;
  const method = stringOf(body.token_endpoint_auth_method);
  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    authMethod:
      method === "client_secret_post" || method === "client_secret_basic" || method === "none"
        ? method
        : clientSecret
          ? "client_secret_basic"
          : "none",
  };
}

const base64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** A random value for `state` and PKCE verifiers. */
export const randomToken = () => base64Url(NodeCrypto.randomBytes(32));

export function pkceChallenge(verifier: string): string {
  return base64Url(NodeCrypto.createHash("sha256").update(verifier).digest());
}

export function authorizationUrl(input: {
  readonly discovery: OAuthDiscovery;
  readonly client: OAuthClient;
  readonly redirectUri: string;
  readonly verifier: string;
  readonly state: string;
}): string {
  const url = new URL(input.discovery.server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.client.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", pkceChallenge(input.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  url.searchParams.set("resource", input.discovery.resource);
  if (input.discovery.scope) url.searchParams.set("scope", input.discovery.scope);
  return url.href;
}

async function requestTokens(
  tokenEndpoint: string,
  client: OAuthClient,
  params: Record<string, string>,
  signal: AbortSignal,
): Promise<OAuthTokens> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (client.authMethod === "client_secret_basic" && client.clientSecret) {
    const credentials = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`;
    headers.authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
  } else {
    body.set("client_id", client.clientId);
    if (client.authMethod === "client_secret_post" && client.clientSecret) {
      body.set("client_secret", client.clientSecret);
    }
  }
  const response = await fetch(tokenEndpoint, { method: "POST", headers, body, signal });
  const json = asRecord(await response.json().catch(() => null));
  if (!response.ok) {
    const code = stringOf(json?.error);
    const message = `The app's sign-in refused the request${code ? ` (${code})` : ""}.`;
    throw response.status === 400 || response.status === 401
      ? new OAuthRejectedError(message)
      : new Error(`The app's sign-in answered HTTP ${response.status}.`);
  }
  const accessToken = stringOf(json?.access_token);
  if (!json || !accessToken) throw new Error("The app's sign-in returned no access token.");
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : Number(json.expires_in);
  return {
    accessToken,
    refreshToken: stringOf(json.refresh_token),
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
  };
}

export const exchangeCode = (
  input: {
    readonly tokenEndpoint: string;
    readonly client: OAuthClient;
    readonly code: string;
    readonly verifier: string;
    readonly redirectUri: string;
    readonly resource: string;
  },
  signal: AbortSignal,
) =>
  requestTokens(
    input.tokenEndpoint,
    input.client,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
      resource: input.resource,
    },
    signal,
  );

export const refreshTokens = (
  input: {
    readonly tokenEndpoint: string;
    readonly client: OAuthClient;
    readonly refreshToken: string;
    readonly resource: string;
  },
  signal: AbortSignal,
) =>
  requestTokens(
    input.tokenEndpoint,
    input.client,
    { grant_type: "refresh_token", refresh_token: input.refreshToken, resource: input.resource },
    signal,
  );
