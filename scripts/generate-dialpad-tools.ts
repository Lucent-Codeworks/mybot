/**
 * Regenerates the Dialpad app's API tools from Dialpad's OpenAPI spec:
 *
 *   node scripts/generate-dialpad-tools.ts [spec.json]
 *
 * Without a path it downloads https://dialpad.com/static/openapi/platform-v1.0.json.
 * Writes apps/server/src/apps/builtin/dialpadApi.gen.ts, one entry per
 * operation, with $refs inlined and descriptions cut to what a bot needs.
 * Operations the hand-written tools in dialpad.ts cover, and OAuth's own
 * endpoints, are left out.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const SPEC_URL = "https://dialpad.com/static/openapi/platform-v1.0.json";
const OUTPUT = NodePath.join(
  import.meta.dirname,
  "../apps/server/src/apps/builtin/dialpadApi.gen.ts",
);

/** Covered by a hand-written tool in dialpad.ts. */
const HAND_WRITTEN = new Set([
  "users.list",
  "search.users",
  "call.list",
  "call.get_call_info",
  "call.initiate",
  "call.get_ai_recap",
  "transcripts.get",
  "sms.send",
  "contacts.list",
  "contacts.get",
  "contacts.create",
  "contacts.update",
]);

/** Operations that reach people outside the app: a call, text, fax, or message goes out. */
const OUTWARD = new Set([
  "bulk_messages.send",
  "call.initiate_ivr_call",
  "call.participants.add",
  "callback.enqueue",
  "fax.send",
  "scheduled_messages.create",
  "scheduled_messages.send_now",
  "users.initiate_call",
]);

const DESCRIPTION_MAX = 320;

type Json = Record<string, unknown>;
interface Operation {
  operationId: string;
  description?: string;
  summary?: string;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: Json;
  }>;
  requestBody?: { required?: boolean; content: Record<string, { schema: Json }> };
  "x-access"?: string[];
}

/** First paragraph, without Dialpad's formatting hints, cut to a sentence or two. */
const shorten = (text: string | undefined, max = DESCRIPTION_MAX): string | undefined => {
  if (!text) return undefined;
  const paragraph =
    text
      .replace(/\[single-line only\]/g, "")
      .split(/\n\s*\n/)
      .map((part) => part.replace(/\s+/g, " ").trim())
      .find((part) => part.length > 0) ?? "";
  if (!paragraph) return undefined;
  return paragraph.length <= max ? paragraph : `${paragraph.slice(0, max - 1).trimEnd()}…`;
};

/** Dialpad's rate limit, when it is low enough for a bot to plan around. */
const rateLimit = (text: string | undefined) => {
  const limit = /Rate limit: ([^\n.]+)/.exec(text ?? "")?.[1];
  const perMinute = /^(\d+) per minute$/.exec(limit ?? "");
  return perMinute && Number(perMinute[1]) >= 250 ? undefined : limit;
};

const main = async () => {
  const source = process.argv[2];
  const spec = JSON.parse(
    source ? await NodeFSP.readFile(source, "utf8") : await (await fetch(SPEC_URL)).text(),
  ) as { paths: Record<string, Record<string, Operation>>; components: { schemas: Json } };
  const schemas = spec.components.schemas as Record<string, Json>;

  /** A bot-facing copy of `schema`: refs inlined, nulls dropped, 64-bit ids as digit strings. */
  const simplify = (schema: Json | undefined, depth = 0): Json => {
    if (!schema) return {};
    if (depth > 8) return { type: "object" };
    if (typeof schema.$ref === "string") {
      const target = schemas[schema.$ref.replace("#/components/schemas/", "")];
      if (!target) throw new Error(`Unknown schema ${schema.$ref}`);
      return simplify({ ...target, ...withoutKeys(schema, ["$ref", "type"]) }, depth + 1);
    }
    const out: Json = {};
    let type = schema.type;
    if (Array.isArray(type)) {
      const types = type.filter((entry) => entry !== "null");
      type = types.length === 1 ? types[0] : types;
    }
    if (schema.format === "int64") {
      // JSON numbers past 2^53 lose digits on the way, so bots send ids as digits.
      out.type = "string";
      out.pattern = "^\\d+$";
      out.format = "int64";
    } else if (type !== undefined) {
      out.type = type;
    }
    const description = shorten(schema.description as string | undefined);
    if (description) out.description = description;
    if (Array.isArray(schema.enum)) out.enum = schema.enum.filter((entry) => entry !== null);
    if (schema.default !== undefined && schema.default !== null) out.default = schema.default;
    if (schema.items) out.items = simplify(schema.items as Json, depth + 1);
    if (schema.properties) {
      out.properties = Object.fromEntries(
        Object.entries(schema.properties as Record<string, Json>).map(([name, property]) => [
          name,
          simplify(property, depth + 1),
        ]),
      );
      if (Array.isArray(schema.required) && schema.required.length > 0) {
        out.required = schema.required;
      }
    }
    return out;
  };

  const operations: Json[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const id = operation.operationId;
      if (id.startsWith("oauth2.") || HAND_WRITTEN.has(id)) continue;
      const properties: Record<string, Json> = {};
      const required: string[] = [];
      const pathParams: string[] = [];
      const queryParams: string[] = [];
      for (const parameter of operation.parameters ?? []) {
        if (parameter.in !== "path" && parameter.in !== "query") {
          throw new Error(`${id}: unsupported ${parameter.in} parameter ${parameter.name}`);
        }
        const schema = simplify(parameter.schema);
        const description = shorten(parameter.description);
        properties[parameter.name] = description ? { ...schema, description } : schema;
        if (parameter.in === "path") pathParams.push(parameter.name);
        else queryParams.push(parameter.name);
        if (parameter.required || parameter.in === "path") required.push(parameter.name);
      }
      const body = operation.requestBody?.content["application/json"]?.schema;
      if (operation.requestBody && !body) throw new Error(`${id}: body is not JSON`);
      if (body) {
        if (properties.body) throw new Error(`${id}: a parameter is named body`);
        properties.body = { ...simplify(body), description: "The request body." };
        if (operation.requestBody?.required) required.push("body");
      }
      const notes = [
        OUTWARD.has(id)
          ? "ACTS FOR REAL: reaches people outside Dialpad. Confirm with the user first."
          : method === "delete"
            ? "Deletes for good. Confirm with the user first."
            : undefined,
        shorten(operation.description) ?? operation.summary,
        operation["x-access"]?.includes("admin") ? "Needs a company (admin) API key." : undefined,
        rateLimit(operation.description)
          ? `Dialpad allows ${rateLimit(operation.description)}.`
          : undefined,
      ].filter(Boolean);
      operations.push({
        name: id.replace(/[.-]/g, "_"),
        method: method.toUpperCase(),
        path: path.replace(/^\/api\/v2/, ""),
        description: notes.join(" "),
        pathParams,
        queryParams,
        inputSchema: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
      });
    }
  }
  operations.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const names = new Set(operations.map((operation) => operation.name));
  if (names.size !== operations.length) throw new Error("Two operations share a tool name.");

  await NodeFSP.writeFile(
    OUTPUT,
    [
      "// Generated by scripts/generate-dialpad-tools.ts from Dialpad's OpenAPI spec. Do not edit.",
      'import type { DialpadOperation } from "./dialpadApi.ts";',
      "",
      `export const DIALPAD_OPERATIONS: ReadonlyArray<DialpadOperation> = ${JSON.stringify(operations)};`,
      "",
    ].join("\n"),
  );
  console.log(
    `Wrote ${operations.length} Dialpad operations to ${NodePath.relative(process.cwd(), OUTPUT)}.`,
  );
};

function withoutKeys(record: Json, keys: ReadonlyArray<string>): Json {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

await main();
