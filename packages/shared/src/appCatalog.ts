import type { AppConnectionAddInput, ProjectIconColor } from "@t3tools/contracts";

/**
 * The app catalog: ready-made connections for popular apps. Each preset lists
 * the fields the user fills in and turns them into an MCP transport. Values
 * of secret fields are sent to the server once and never shown again.
 */

export interface AppPresetField {
  readonly key: string;
  readonly label: string;
  /** Shown as a password input and kept out of the connection's display. */
  readonly secret?: boolean;
  /** An empty optional field is left out. */
  readonly optional?: boolean;
  readonly placeholder?: string;
  readonly default?: string;
  readonly help?: string;
}

export type AppPresetTransport = AppConnectionAddInput["transport"];

export interface AppPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly category: "Phone & messaging" | "Automation";
  readonly icon: { readonly name: string; readonly color: ProjectIconColor };
  readonly docsUrl: string;
  /** Something the user should know before connecting, such as an access requirement. */
  readonly note?: string;
  readonly fields: ReadonlyArray<AppPresetField>;
  /** Builds the transport from trimmed field values; required fields are non-empty. */
  readonly transport: (values: Readonly<Record<string, string>>) => AppPresetTransport;
}

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, "");

export const APP_CATALOG: ReadonlyArray<AppPreset> = [
  {
    id: "dialpad",
    name: "Dialpad",
    summary: "Calls, messages, contacts, and call summaries from your Dialpad account.",
    category: "Phone & messaging",
    icon: { name: "phone", color: "violet" },
    docsUrl: "https://developers.dialpad.com/docs/dialpad-mcp-server",
    note: "Dialpad's MCP server is in an early access program; without access, Dialpad refuses the connection. You sign in with Dialpad in your browser, and sessions last 24 hours.",
    fields: [
      {
        key: "url",
        label: "MCP server URL",
        default: "https://mcp.dialpad.com/mcp",
        placeholder: "https://mcp.dialpad.com/mcp",
        help: "Accounts outside the US may need a regional URL; ask api@dialpad.com.",
      },
    ],
    transport: (values) => ({ type: "http", url: values.url ?? "", auth: "oauth" }),
  },
  {
    id: "telnyx",
    name: "Telnyx",
    summary: "Send messages, place calls, and manage numbers with your Telnyx API key.",
    category: "Phone & messaging",
    icon: { name: "message-square", color: "emerald" },
    docsUrl: "https://developers.telnyx.com/docs/development/mcp/remote-mcp",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        secret: true,
        placeholder: "KEY…",
        help: "Create one in the Telnyx portal under API Keys.",
      },
    ],
    transport: (values) => ({
      type: "http",
      url: "https://api.telnyx.com/v2/mcp",
      bearerToken: values.apiKey ?? "",
      auth: "token",
    }),
  },
  {
    id: "telnyx-read-only",
    name: "Telnyx (read-only)",
    summary: "Look up your Telnyx numbers, messages, and calls without changing anything.",
    category: "Phone & messaging",
    icon: { name: "eye", color: "emerald" },
    docsUrl: "https://developers.telnyx.com/docs/development/mcp/remote-mcp",
    note: "You sign in with Telnyx in your browser.",
    fields: [],
    transport: () => ({ type: "http", url: "https://api.telnyx.com/v2/ai/mcp", auth: "oauth" }),
  },
  {
    id: "twilio",
    name: "Twilio",
    summary: "Messaging, voice, and numbers through Twilio's APIs.",
    category: "Phone & messaging",
    icon: { name: "phone-call", color: "red" },
    docsUrl: "https://github.com/twilio-labs/mcp",
    note: "Runs Twilio's MCP server with npx, so this computer needs Node.js.",
    fields: [
      { key: "accountSid", label: "Account SID", placeholder: "AC…" },
      {
        key: "apiKey",
        label: "API key",
        placeholder: "SK…",
        help: "Create an API key in the Twilio Console under API keys & tokens.",
      },
      { key: "apiSecret", label: "API secret", secret: true },
      {
        key: "services",
        label: "Services",
        default: "twilio_api_v2010",
        help: "Twilio APIs to load, comma-separated, e.g. twilio_api_v2010, twilio_messaging_v1",
      },
    ],
    transport: (values) => ({
      type: "stdio",
      command: "npx",
      args: [
        "-y",
        "@twilio-alpha/mcp",
        `${values.accountSid}/${values.apiKey}:${values.apiSecret}`,
        "--services",
        (values.services ?? "")
          .split(",")
          .map((service) => service.trim())
          .filter(Boolean)
          .join(","),
      ],
    }),
  },
  {
    id: "n8n",
    name: "n8n",
    summary: "Run the n8n workflows you made available to MCP clients.",
    category: "Automation",
    icon: { name: "workflow", color: "rose" },
    docsUrl: "https://docs.n8n.io/advanced-ai/accessing-n8n-mcp-server/",
    note: "Turn on instance-level MCP in n8n under Settings → Instance-level MCP.",
    fields: [
      { key: "url", label: "n8n URL", placeholder: "https://n8n.example.com" },
      {
        key: "accessToken",
        label: "Access token",
        secret: true,
        optional: true,
        help: "From Settings → Instance-level MCP → Connect a client. Leave empty to sign in with n8n in your browser.",
      },
    ],
    transport: (values) => {
      const url = `${withoutTrailingSlash(values.url ?? "")}/mcp-server/http`;
      return values.accessToken
        ? { type: "http", url, bearerToken: values.accessToken, auth: "token" }
        : { type: "http", url, auth: "oauth" };
    },
  },
  {
    id: "activepieces",
    name: "Activepieces",
    summary: "Use your Activepieces flows and pieces as tools.",
    category: "Automation",
    icon: { name: "puzzle", color: "purple" },
    docsUrl: "https://www.activepieces.com/docs/mcp/overview",
    note: "You sign in with Activepieces in your browser.",
    fields: [
      {
        key: "url",
        label: "Server URL",
        placeholder: "https://your-instance.com/mcp",
        help: "Copy it from Activepieces under Settings → MCP Server.",
      },
    ],
    transport: (values) => ({ type: "http", url: values.url ?? "", auth: "oauth" }),
  },
];

export const findAppPreset = (id: string): AppPreset | undefined =>
  APP_CATALOG.find((preset) => preset.id === id);

/** The value a field starts with in the form. */
export const appPresetFieldDefault = (field: AppPresetField) => field.default ?? "";

/**
 * The add input for a preset filled with `values`, or the first missing
 * required field. Values are trimmed; empty optional fields are dropped.
 */
export function buildAppConnectionInput(
  preset: AppPreset,
  values: Readonly<Record<string, string>>,
  options: { readonly name?: string; readonly redirectBaseUrl?: string } = {},
): { readonly input: AppConnectionAddInput } | { readonly missing: AppPresetField } {
  const trimmed: Record<string, string> = {};
  for (const field of preset.fields) {
    const value = (values[field.key] ?? "").trim();
    if (value === "" && !field.optional) return { missing: field };
    if (value !== "") trimmed[field.key] = value;
  }
  return {
    input: {
      name: options.name?.trim() || preset.name,
      presetId: preset.id,
      transport: preset.transport(trimmed),
      ...(options.redirectBaseUrl ? { redirectBaseUrl: options.redirectBaseUrl } : {}),
    },
  };
}
