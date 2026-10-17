import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMyBotProjectFileJsonSchema,
  parseMyBotProjectFile,
  MyBotProjectFileFromJson,
} from "./myBotProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(MyBotProjectFileFromJson);

describe("buildMyBotProjectFileJsonSchema", () => {
  it("emits a draft 2020-12 schema with the published $id", () => {
    const schema = buildMyBotProjectFileJsonSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://t3.codes/schema/t3.json");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("documents every supported field", () => {
    const schema = buildMyBotProjectFileJsonSchema() as {
      properties: Record<
        string,
        {
          description?: string;
          items?: { properties: Record<string, unknown>; required: ReadonlyArray<string> };
        }
      >;
      required?: ReadonlyArray<string>;
    };

    expect(Object.keys(schema.properties).sort()).toEqual(["$schema", "iconPath", "scripts"]);
    expect(schema.required).toBeUndefined();
    expect(schema.properties.iconPath?.description).toContain("Workspace-relative path");

    const script = schema.properties.scripts?.items;
    expect(script?.required).toEqual(["name", "command"]);
    expect(Object.keys(script?.properties ?? {}).sort()).toEqual([
      "autoOpenPreview",
      "command",
      "icon",
      "name",
      "previewUrl",
    ]);
  });

  it("stays JSON-serializable", () => {
    const schema = buildMyBotProjectFileJsonSchema();
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
  });
});

describe("MyBotProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });

  it("fails on malformed JSON", () => {
    expect(() => decodeJson("{ not json")).toThrow();
  });
});

describe("parseMyBotProjectFile", () => {
  it("returns the decoded file for valid contents", () => {
    expect(parseMyBotProjectFile('{ "iconPath": "assets/logo.svg" }')).toEqual({
      iconPath: "assets/logo.svg",
    });
  });

  it("returns null for malformed or invalid contents", () => {
    expect(parseMyBotProjectFile("{ not json")).toBeNull();
    expect(parseMyBotProjectFile('{ "scripts": [{ "name": "Dev" }] }')).toBeNull();
  });
});
