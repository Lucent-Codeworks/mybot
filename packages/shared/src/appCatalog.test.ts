import { AppConnectionAddInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { APP_CATALOG, buildAppConnectionInput, findAppPreset } from "./appCatalog.ts";

const isAddInput = Schema.is(AppConnectionAddInput);

const sampleValue = (key: string) =>
  key === "url" ? "https://app.example.com/mcp" : `sample-${key}`;

describe("the app catalog", () => {
  it("builds a valid add input from every preset", () => {
    const ids = APP_CATALOG.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of APP_CATALOG) {
      const values = Object.fromEntries(
        preset.fields.map((field) => [field.key, field.default ?? sampleValue(field.key)]),
      );
      const built = buildAppConnectionInput(preset, values);
      expect("input" in built, preset.id).toBe(true);
      if (!("input" in built)) continue;
      expect(isAddInput(built.input), preset.id).toBe(true);
      expect(built.input).toMatchObject({ name: preset.name, presetId: preset.id });
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
});
