import { AppConnectionAddInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  APP_CATALOG,
  APP_CATEGORIES,
  type AppPreset,
  type AppPresetField,
  appPresetFieldDefault,
  buildAppConnectionInput,
  findAppPreset,
} from "./appCatalog.ts";

const decodeAddInput = Schema.decodeUnknownSync(AppConnectionAddInput);

const sampleValue = (field: AppPresetField) =>
  field.kind === "toggle"
    ? "true"
    : field.kind === "select"
      ? field.default
      : (field.default ??
        (field.key === "url" ? "https://app.example.com" : `sample-${field.key}`));

const sampleValues = (preset: AppPreset) =>
  Object.fromEntries(preset.fields.map((field) => [field.key, sampleValue(field)]));

/** Every string the built transport carries, to find which fields it used. */
const transportStrings = (preset: AppPreset, values: Record<string, string>) => {
  const transport = preset.transport(values);
  return transport.type === "http"
    ? [transport.url, transport.bearerToken ?? ""]
    : [transport.command, ...transport.args, ...Object.values(transport.env ?? {})];
};

/** Plain text fields that still hold a credential. */
const CREDENTIAL_KEYS = new Set(["apiKey", "clientId", "accountSid", "applicationId"]);
/** Credentials from the user's own system, such as a database, with no provider page to link. */
const OWN_SYSTEM_CREDENTIALS = new Set(["postgres.uri", "logseq.token"]);

const RUNTIME_OF_COMMAND = { npx: "node", uvx: "uv", docker: "docker" } as const;

describe("the app catalog", () => {
  it("has unique ids and known categories", () => {
    const ids = APP_CATALOG.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of APP_CATALOG) {
      expect(APP_CATEGORIES, preset.id).toContain(preset.category);
    }
  });

  // Users are not developers, so a README is no setup guide: every credential says where to
  // get it, and links to the provider's own page unless it comes from the user's own system.
  it("says where to get every credential", () => {
    for (const preset of APP_CATALOG) {
      for (const field of preset.fields) {
        if (field.kind === "toggle" || field.kind === "select") continue;
        if (field.kind !== "secret" && !CREDENTIAL_KEYS.has(field.key)) continue;
        const name = `${preset.id}.${field.key}`;
        expect(field.help, name).toBeTruthy();
        if (OWN_SYSTEM_CREDENTIALS.has(name)) continue;
        expect(field.getAt, name).toMatch(/^https:\/\//);
        if (preset.id !== "github") expect(field.getAt, name).not.toMatch(/github\.com/);
      }
    }
  });

  // One test over the whole catalog; a failure names the preset.
  it("builds a valid add input from every preset, using every field", () => {
    for (const preset of APP_CATALOG) {
      const values = sampleValues(preset);
      const built = buildAppConnectionInput(preset, values);
      expect("input" in built, preset.id).toBe(true);
      if (!("input" in built)) continue;
      expect(() => decodeAddInput(built.input), preset.id).not.toThrow();
      if (preset.via) continue;
      expect(built.input).toMatchObject({ name: preset.name, presetId: preset.id });

      // Each text field's sample value reaches the transport, so no field key is misspelled.
      const strings = transportStrings(preset, values).join("\n");
      for (const field of preset.fields) {
        if (field.kind === "toggle" || field.kind === "select") continue;
        expect(strings, `${preset.id}.${field.key}`).toContain(values[field.key]);
      }
    }
  });

  it("starts selects on a valid option and declares how local apps run", () => {
    for (const preset of APP_CATALOG) {
      for (const field of preset.fields) {
        if (field.kind !== "select") continue;
        expect(
          field.options.map((option) => option.value),
          `${preset.id}.${field.key}`,
        ).toContain(appPresetFieldDefault(field));
      }
      const transport = preset.transport(sampleValues(preset));
      expect(transport.type === "stdio", preset.id).toBe(preset.connection === "local");
      if (transport.type === "stdio") {
        expect(preset.requires, preset.id).toBe(
          RUNTIME_OF_COMMAND[transport.command as keyof typeof RUNTIME_OF_COMMAND],
        );
      }
    }
  });

  it("connects cards that go through Composio to the Composio server", () => {
    const composio = findAppPreset("composio")!;
    const viaCards = APP_CATALOG.filter((preset) => preset.via === "composio");
    expect(viaCards.map((preset) => preset.id)).toEqual(
      expect.arrayContaining(["gmail", "google-calendar", "google-drive"]),
    );
    for (const card of viaCards) {
      const built = buildAppConnectionInput(card, {});
      expect("input" in built && built.input, card.id).toEqual({
        name: "Composio",
        presetId: "composio",
        transport: composio.transport({}),
      });
    }
  });

  it("reports the first missing required field and drops empty optional ones", () => {
    const twilio = findAppPreset("twilio")!;
    const missing = buildAppConnectionInput(twilio, { accountSid: "AC1", apiKey: " " });
    expect("missing" in missing && missing.missing.key).toBe("apiKey");

    const built = buildAppConnectionInput(twilio, {
      accountSid: "AC1",
      apiKey: "SK1",
      apiSecret: "shh",
      services: "twilio_api_v2010, twilio_messaging_v1",
    });
    expect("input" in built && built.input.transport).toEqual({
      type: "stdio",
      command: "npx",
      args: [
        "-y",
        "@twilio-alpha/mcp",
        "AC1/SK1:shh",
        "--services",
        "twilio_api_v2010,twilio_messaging_v1",
      ],
    });

    const n8n = findAppPreset("n8n")!;
    const oauth = buildAppConnectionInput(n8n, {
      url: "https://n8n.example.com/",
      accessToken: "",
    });
    expect("input" in oauth && oauth.input.transport).toEqual({
      type: "http",
      url: "https://n8n.example.com/mcp-server/http",
      auth: "oauth",
    });
    const token = buildAppConnectionInput(n8n, {
      url: "https://n8n.example.com",
      accessToken: "t",
    });
    expect("input" in token && token.input.transport).toMatchObject({
      bearerToken: "t",
      auth: "token",
    });
  });

  it("maps selects and toggles onto the command", () => {
    const outlook = findAppPreset("outlook")!;
    const personal = buildAppConnectionInput(outlook, { account: "personal", readOnly: "" });
    expect("input" in personal && personal.input.transport).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@softeria/ms-365-mcp-server"],
      env: { MS365_MCP_TENANT_ID: "consumers" },
    });
    const work = buildAppConnectionInput(outlook, { account: "work", readOnly: "true" });
    expect("input" in work && work.input.transport).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@softeria/ms-365-mcp-server", "--org-mode", "--read-only"],
    });

    const firecrawl = findAppPreset("firecrawl")!;
    const signIn = buildAppConnectionInput(firecrawl, {});
    expect("input" in signIn && signIn.input.transport).toEqual({
      type: "http",
      url: "https://mcp.firecrawl.dev/v2/mcp-oauth",
      auth: "oauth",
    });
    const key = buildAppConnectionInput(firecrawl, { apiKey: "fc-1" });
    expect("input" in key && key.input.transport).toEqual({
      type: "http",
      url: "https://mcp.firecrawl.dev/v2/mcp",
      bearerToken: "fc-1",
      auth: "token",
    });
  });

  // iCloud only sends over STARTTLS on 587, which the email server never uses by default.
  it("uses STARTTLS for email on ports other than the secure ones", () => {
    const email = findAppPreset("email")!;
    const account = { address: "me@icloud.com", password: "p", imapHost: "imap.mail.me.com" };
    const secure = buildAppConnectionInput(email, {
      ...account,
      imapPort: "993",
      smtpHost: "smtp.gmail.com",
      smtpPort: "465",
    });
    expect("input" in secure && secure.input.transport).not.toHaveProperty(
      "env.MCP_EMAIL_SERVER_SMTP_START_SSL",
    );
    const startTls = buildAppConnectionInput(email, {
      ...account,
      imapPort: "143",
      smtpHost: "smtp.mail.me.com",
      smtpPort: "587",
    });
    expect("input" in startTls && startTls.input.transport).toMatchObject({
      env: {
        MCP_EMAIL_SERVER_IMAP_SSL: "false",
        MCP_EMAIL_SERVER_IMAP_START_SSL: "true",
        MCP_EMAIL_SERVER_SMTP_SSL: "false",
        MCP_EMAIL_SERVER_SMTP_START_SSL: "true",
      },
    });
  });

  it("lets email send to any recipient", () => {
    const email = findAppPreset("email")!;
    const result = buildAppConnectionInput(email, {
      address: "me@example.com",
      password: "p",
      imapHost: "imap.example.com",
      imapPort: "993",
      smtpHost: "smtp.example.com",
      smtpPort: "465",
    });
    expect("input" in result && result.input.transport).toMatchObject({
      env: { MCP_EMAIL_SERVER_ALLOWED_RECIPIENTS: "*" },
    });
  });

  it("connects Paddle sandbox keys to the sandbox server", () => {
    const paddle = findAppPreset("paddle")!;
    const sandbox = buildAppConnectionInput(paddle, { apiKey: "pdl_sdbx_apikey_1" });
    expect("input" in sandbox && sandbox.input.transport).toEqual({
      type: "http",
      url: "https://sandbox-mcp.paddle.com/mcp",
      bearerToken: "pdl_sdbx_apikey_1",
      auth: "token",
    });
    const live = buildAppConnectionInput(paddle, { apiKey: "pdl_live_apikey_1" });
    expect("input" in live && live.input.transport).toMatchObject({
      url: "https://mcp.paddle.com/mcp",
      auth: "token",
    });
    const signIn = buildAppConnectionInput(paddle, {});
    expect("input" in signIn && signIn.input.transport).toMatchObject({ auth: "oauth" });
  });

  it("connects Instacart development keys to Instacart's test server", () => {
    const instacart = findAppPreset("instacart")!;
    const development = buildAppConnectionInput(instacart, {
      apiKey: "k",
      environment: "development",
    });
    expect("input" in development && development.input.transport).toMatchObject({
      url: "https://mcp.dev.instacart.tools/mcp",
      bearerToken: "k",
    });
    const production = buildAppConnectionInput(instacart, {
      apiKey: "k",
      environment: "production",
    });
    expect("input" in production && production.input.transport).toMatchObject({
      url: "https://mcp.instacart.com/mcp",
    });
  });
});
