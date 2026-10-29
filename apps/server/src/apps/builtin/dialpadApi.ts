import { ToolError } from "./index.ts";

/**
 * One Dialpad REST operation as a tool, generated from Dialpad's OpenAPI spec
 * into dialpadApi.gen.ts. Path and query parameters are top-level
 * arguments and the JSON request body is `body`.
 */
export interface DialpadOperation {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Under /api/v2, with `{name}` placeholders for path parameters. */
  readonly path: string;
  readonly description: string;
  readonly pathParams: ReadonlyArray<string>;
  readonly queryParams: ReadonlyArray<string>;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

type Schema = {
  readonly type?: unknown;
  readonly format?: string;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly items?: Schema;
};

export interface DialpadRequest {
  readonly method: DialpadOperation["method"];
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  /** The JSON body, already encoded so 64-bit ids keep every digit. */
  readonly body?: string;
}

const isInt64 = (schema: Schema | undefined) => schema?.format === "int64";

/** A 64-bit id as its digits; bots pass ids as strings or numbers. */
const int64Digits = (value: unknown, name: string): string => {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^\d+$/.test(text.trim())) {
    throw new ToolError(`${name} must be a Dialpad id (digits).`);
  }
  return text.trim();
};

/**
 * JSON for `value`, writing fields the schema marks as 64-bit ids as bare
 * numbers with all their digits; JSON.stringify would round them.
 */
export const encodeDialpadJson = (
  value: unknown,
  schema: Schema | undefined,
  name = "body",
): string => {
  if (value === undefined) return "null";
  if (isInt64(schema) && value !== null) return int64Digits(value, name);
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => encodeDialpadJson(item, schema?.items, `${name}[${index}]`)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    return `{${entries
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${encodeDialpadJson(entry, schema?.properties?.[key], `${name}.${key}`)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const scalar = (value: unknown, schema: Schema | undefined, name: string): string => {
  if (isInt64(schema)) return int64Digits(value, name);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new ToolError(`${name} must be a single value.`);
};

/** The request `args` make for `operation`; a missing or malformed argument is a ToolError. */
export const dialpadRequest = (
  operation: DialpadOperation,
  args: Readonly<Record<string, unknown>>,
): DialpadRequest => {
  const properties = (operation.inputSchema as Schema).properties ?? {};
  const present = (name: string) =>
    args[name] !== undefined && args[name] !== null && args[name] !== "";
  const required = (operation.inputSchema.required as ReadonlyArray<string> | undefined) ?? [];
  const missing = required.filter((name) => !present(name));
  if (missing.length > 0) throw new ToolError(`Missing ${missing.join(", ")}.`);
  const path = operation.path.replace(/\{(\w+)\}/g, (_match, name: string) =>
    encodeURIComponent(scalar(args[name], properties[name], name)),
  );
  const query: Record<string, string> = {};
  for (const name of operation.queryParams) {
    if (present(name)) query[name] = scalar(args[name], properties[name], name);
  }
  const known = new Set([...operation.pathParams, ...operation.queryParams, "body"]);
  const unknown = Object.keys(args).filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new ToolError(
      `Unknown argument ${unknown.join(", ")}.${properties.body ? " Request fields go in body." : ""}`,
    );
  }
  if (args.body === undefined || args.body === null)
    return { method: operation.method, path, query };
  if (!properties.body) throw new ToolError(`${operation.name} takes no body.`);
  if (typeof args.body !== "object" || Array.isArray(args.body)) {
    throw new ToolError("body must be an object.");
  }
  return {
    method: operation.method,
    path,
    query,
    body: encodeDialpadJson(args.body, properties.body),
  };
};
