import type { AppConnectionAddInput, ProjectIconColor } from "@t3tools/contracts";

/**
 * The app catalog: ready-made connections for popular apps. Each preset lists
 * the fields the user fills in and turns them into an MCP transport. Values
 * of secret fields are sent to the server once and never shown again.
 */

interface AppPresetFieldBase {
  readonly key: string;
  readonly label: string;
  readonly help?: string;
}

/**
 * A form field. Every value is a string: a toggle is "true" when on and empty
 * when off, a select holds one of its option values.
 */
export type AppPresetField =
  | (AppPresetFieldBase & {
      /** "secret" is a password input kept out of the connection's display. */
      readonly kind?: "text" | "secret";
      /** An empty optional field is left out. */
      readonly optional?: boolean;
      readonly placeholder?: string;
      readonly default?: string;
    })
  | (AppPresetFieldBase & {
      readonly kind: "select";
      readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
      readonly default: string;
    })
  | (AppPresetFieldBase & { readonly kind: "toggle"; readonly default?: boolean });

export type AppPresetTransport = AppConnectionAddInput["transport"];

export const APP_CATEGORIES = [
  "Email & calendar",
  "Docs & files",
  "Chat & meetings",
  "Projects & development",
  "Sales & support",
  "Payments & finance",
  "Marketing & social",
  "Phone & SMS",
  "Search & web",
  "Travel & home",
  "Design & media",
  "Data & AI",
  "Health & personal",
  "Automation",
] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];

/**
 * How the user connects: signs in through the browser, pastes a key, runs the
 * app on this computer, or nothing at all.
 */
export type AppConnectionKind = "sign-in" | "api-key" | "local" | "open";

export interface AppPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly category: AppCategory;
  /** The tile color when there is no brand logo. */
  readonly color: ProjectIconColor;
  readonly docsUrl: string;
  /** Something the user should know before connecting, such as an access requirement. */
  readonly note?: string;
  readonly connection: AppConnectionKind;
  /** What a local app needs installed on this computer. */
  readonly requires?: "node" | "uv" | "docker";
  /** Only works on these operating systems. */
  readonly platforms?: ReadonlyArray<"darwin">;
  /** Run by the app's maker or a service company, not a community package. */
  readonly official: boolean;
  readonly popular?: true;
  /** Extra search words, such as products the app also covers. */
  readonly keywords?: ReadonlyArray<string>;
  /** Connects through an app aggregator instead of its own server. */
  readonly via?: "composio";
  readonly fields: ReadonlyArray<AppPresetField>;
  /** Builds the transport from trimmed field values; required fields are non-empty. */
  readonly transport: (values: Readonly<Record<string, string>>) => AppPresetTransport;
}

export const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, "");

export const oauth = (url: string) => (): AppPresetTransport => ({
  type: "http",
  url,
  auth: "oauth",
});

export const open = (url: string) => (): AppPresetTransport => ({
  type: "http",
  url,
  auth: "none",
});

/** A fixed key field sent as a bearer token. */
export const bearer =
  (url: string, key = "apiKey") =>
  (values: Readonly<Record<string, string>>): AppPresetTransport => ({
    type: "http",
    url,
    bearerToken: values[key] ?? "",
    auth: "token",
  });

/** Signs in (or connects openly) unless the optional key field is filled. */
export const tokenOptional =
  (url: string, otherwise: "oauth" | "none", key = "apiKey", tokenUrl = url) =>
  (values: Readonly<Record<string, string>>): AppPresetTransport =>
    values[key]
      ? { type: "http", url: tokenUrl, bearerToken: values[key], auth: "token" }
      : { type: "http", url, auth: otherwise };

export const optionalKeyField = (help: string): AppPresetField => ({
  key: "apiKey",
  label: "API key",
  kind: "secret",
  optional: true,
  help,
});

/** Env entries for the fields that have a value. */
export const envOf = (
  values: Readonly<Record<string, string>>,
  mapping: Readonly<Record<string, string>>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [variable, key] of Object.entries(mapping)) {
    const value = values[key];
    if (value) env[variable] = value;
  }
  return env;
};

export const COMPOSIO_URL = "https://connect.composio.dev/mcp";

/**
 * A card for an app reached through Composio's single sign-in, for apps
 * whose own MCP server MyBot cannot sign in to. `service` names who Composio
 * asks the user to sign in to on first use, or `apiKey` when it asks for a key.
 */
export const viaComposio = (
  id: string,
  name: string,
  summary: string,
  category: AppCategory,
  keywords: ReadonlyArray<string>,
  options: {
    readonly popular?: true;
    readonly service?: string;
    readonly color?: ProjectIconColor;
    /** Composio asks for the app's API key rather than a sign-in. */
    readonly apiKey?: true;
  } = {},
): AppPreset => ({
  id,
  name,
  summary,
  category,
  color: options.color ?? "blue",
  docsUrl: "https://docs.composio.dev",
  note: `Connect once through Composio; it also covers your other apps. ${
    options.apiKey
      ? `Composio asks for your ${name} API key`
      : `Composio asks you to sign in to ${options.service ?? name}`
  } the first time a bot uses it.`,
  connection: "sign-in",
  official: true,
  via: "composio",
  keywords: ["composio", ...keywords],
  ...(options.popular ? { popular: options.popular } : {}),
  fields: [],
  transport: oauth(COMPOSIO_URL),
});
