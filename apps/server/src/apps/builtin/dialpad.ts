// @effect-diagnostics globalFetch:off
// Promise-based like mcpClient.ts: it runs inside the in-process MCP session.
import { type BuiltinApp, type BuiltinTool, ToolError } from "./index.ts";

/**
 * Dialpad, built into MyBot: calls, AI recaps, texts, and contacts through
 * Dialpad's REST API with an API key. Reference:
 * https://developers.dialpad.com/reference. Call and user ids are 64-bit
 * integers, beyond JavaScript's safe range, so they travel as digit strings.
 */

const BASE_URL = "https://dialpad.com/api/v2";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
type Args = Readonly<Record<string, unknown>>;

// --- Arguments ---

const optionalString = (args: Args, key: string): string | undefined => {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ToolError(`${key} must be a string.`);
  return value.trim() || undefined;
};

const requiredString = (args: Args, key: string): string => {
  const value = optionalString(args, key);
  if (value === undefined) throw new ToolError(`${key} is required.`);
  return value;
};

const optionalBoolean = (args: Args, key: string): boolean | undefined => {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ToolError(`${key} must be true or false.`);
  return value;
};

const optionalStrings = (args: Args, key: string): ReadonlyArray<string> | undefined => {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ToolError(`${key} must be a list of strings.`);
  }
  return value;
};

/** A Dialpad id as digits; bots may pass it as a number or a string. */
const optionalId = (args: Args, key: string): string | undefined => {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d+$/.test(text.trim())) {
    throw new ToolError(`${key} must be a Dialpad id (digits).`);
  }
  return text.trim();
};

const requiredId = (args: Args, key: string): string => {
  const value = optionalId(args, key);
  if (value === undefined) throw new ToolError(`${key} is required.`);
  return value;
};

/** Dialpad takes times as epoch milliseconds; bots pass ISO 8601. */
const optionalTime = (args: Args, key: string): string | undefined => {
  const value = optionalString(args, key);
  if (value === undefined) return undefined;
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) throw new ToolError(`${key} must be an ISO 8601 date or time.`);
  return String(millis);
};

const oneOf = <const T extends string>(
  args: Args,
  key: string,
  options: ReadonlyArray<T>,
): T | undefined => {
  const value = optionalString(args, key);
  if (value === undefined) return undefined;
  if (!(options as ReadonlyArray<string>).includes(value)) {
    throw new ToolError(`${key} must be one of: ${options.join(", ")}.`);
  }
  return value as T;
};

// --- JSON with 64-bit ids ---

/** An id field in a request body: a number when it fits, digits otherwise. */
const idValue = (id: string) => {
  const number = Number(id);
  return Number.isSafeInteger(number) ? number : id;
};

/** Parses Dialpad's JSON, keeping integers too large for a number as their digits. */
export const parseDialpadJson = (text: string): unknown =>
  JSON.parse(text, function (_key, value: unknown, context?: { source?: string }) {
    return typeof value === "number" &&
      !Number.isSafeInteger(value) &&
      context?.source !== undefined &&
      /^-?\d+$/.test(context.source)
      ? context.source
      : value;
  } as (key: string, value: unknown) => unknown);

const withoutUndefined = (record: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

// --- Schemas ---

const string = (description: string) => ({ type: "string", description });
const id = (description: string) => ({ type: "string", pattern: "^\\d+$", description });
const strings = (description: string) => ({
  type: "array",
  items: { type: "string" },
  description,
});
const boolean = (description: string) => ({ type: "boolean", description });
const choice = (options: ReadonlyArray<string>, description: string) => ({
  type: "string",
  enum: options,
  description,
});
const object = (
  properties: Record<string, Record<string, unknown>>,
  required: ReadonlyArray<string> = [],
) => ({ type: "object", properties, required, additionalProperties: false });

const CURSOR = string("The cursor from the previous page's answer, for the next page.");
const CALL_ID = id("The call's id, from list_calls.");
const USER_ID = id("A Dialpad user's id, from list_users.");
const TARGET_TYPES = [
  "callcenter",
  "callrouter",
  "channel",
  "coachinggroup",
  "coachingteam",
  "department",
  "office",
  "room",
  "staffgroup",
  "user",
] as const;
const GROUP_TYPES = ["office", "department", "callcenter"] as const;
const SUMMARY_FORMATS = ["short", "medium", "long", "bullet"] as const;

const contactFields = {
  first_name: string("First name."),
  last_name: string("Last name."),
  company_name: string("Company."),
  job_title: string("Job title."),
  phones: strings("Phone numbers in E.164 format, such as +14155551234. The first is primary."),
  emails: strings("Email addresses. The first is primary."),
  urls: strings("Web addresses."),
  extension: string("Extension."),
};

const contactBody = (args: Args) =>
  withoutUndefined({
    first_name: optionalString(args, "first_name"),
    last_name: optionalString(args, "last_name"),
    company_name: optionalString(args, "company_name"),
    job_title: optionalString(args, "job_title"),
    phones: optionalStrings(args, "phones"),
    emails: optionalStrings(args, "emails"),
    urls: optionalStrings(args, "urls"),
    extension: optionalString(args, "extension"),
  });

// --- The app ---

interface Request {
  readonly method?: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly query?: Record<string, string | boolean | undefined>;
  readonly body?: Record<string, unknown>;
}

const reasonOf = (status: number, body: unknown): string => {
  const error = (body as { error?: { message?: unknown } } | null)?.error;
  const message = typeof error?.message === "string" ? `: ${error.message.slice(0, 300)}` : ".";
  switch (status) {
    case 401:
      return "Dialpad refused the API key. Check it in Settings → Apps.";
    case 403:
      return `The Dialpad API key is not allowed to do this${message}`;
    case 404:
      return `Dialpad found no such item${message}`;
    case 429:
      return "Dialpad's rate limit was reached. Wait a minute and try again.";
    default:
      return `Dialpad answered HTTP ${status}${message}`;
  }
};

export function dialpadApp(
  apiKey: string,
  options: { readonly fetch?: Fetch; readonly baseUrl?: string } = {},
): BuiltinApp {
  const send = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? BASE_URL;

  /** Calls Dialpad; a refusal becomes a ToolError the bot reads. */
  const api = async (request: Request, signal: AbortSignal): Promise<unknown> => {
    const url = new URL(`${baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await send(url.toString(), {
      method: request.method ?? "GET",
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        ...(request.body ? { "content-type": "application/json" } : {}),
      },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      signal,
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? parseDialpadJson(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) throw new ToolError(reasonOf(response.status, body));
    return body;
  };

  const tool = (
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    toRequest: (args: Args) => Request,
    shape: (body: unknown) => unknown = (body) => body,
  ): BuiltinTool => ({
    name,
    description,
    inputSchema,
    run: async (args, signal) => shape(await api(toRequest(args), signal)),
  });

  const tools: ReadonlyArray<BuiltinTool> = [
    tool(
      "list_users",
      "List the Dialpad users in the company, or find one by name, email, or phone number. Use it to get the user_id other tools need.",
      object({
        query: string("Finds users whose name, email, or phone number matches."),
        email: string("Only the user with this email address."),
        cursor: CURSOR,
      }),
      (args) => {
        const query = optionalString(args, "query");
        const cursor = optionalString(args, "cursor");
        return query
          ? { path: "/users/search", query: { query, cursor } }
          : { path: "/users", query: { email: optionalString(args, "email"), cursor } };
      },
    ),
    tool(
      "list_calls",
      "List finished calls, newest first. Without a target, a company API key lists the whole company's calls and a user API key lists that user's.",
      object({
        started_after: string("Only calls that started after this ISO 8601 time."),
        started_before: string("Only calls that started before this ISO 8601 time."),
        target_type: choice(TARGET_TYPES, "Only calls of this kind of target; needs target_id."),
        target_id: id("Only calls of this user or group; needs target_type."),
        cursor: CURSOR,
      }),
      (args) => {
        const targetId = optionalId(args, "target_id");
        const targetType = oneOf(args, "target_type", TARGET_TYPES);
        if ((targetId === undefined) !== (targetType === undefined)) {
          throw new ToolError("target_id and target_type go together.");
        }
        return {
          path: "/call",
          query: {
            started_after: optionalTime(args, "started_after"),
            started_before: optionalTime(args, "started_before"),
            target_id: targetId,
            target_type: targetType,
            cursor: optionalString(args, "cursor"),
          },
        };
      },
    ),
    tool(
      "get_call",
      "Get one call's details: who was on it, when, how long, recordings, and voicemail. Dialpad allows only 10 of these a minute; prefer list_calls for many calls.",
      object({ call_id: CALL_ID }, ["call_id"]),
      (args) => ({ path: `/call/${requiredId(args, "call_id")}` }),
    ),
    tool(
      "get_call_transcript",
      "Get what was said on a call, line by line.",
      object({ call_id: CALL_ID }, ["call_id"]),
      (args) => ({ path: `/transcripts/${requiredId(args, "call_id")}` }),
      (body) => {
        const { call_id, lines } = (body ?? {}) as { call_id?: unknown; lines?: unknown };
        return {
          call_id,
          lines: (Array.isArray(lines) ? lines : [])
            .filter((line) => line?.type === "transcript")
            .map((line) => ({ time: line.time, name: line.name, text: line.content })),
        };
      },
    ),
    tool(
      "get_call_summary",
      "Get Dialpad's AI recap of a call: a summary, action items, purposes, and outcome. Dialpad allows 12 of these a minute.",
      object(
        {
          call_id: CALL_ID,
          format: choice(SUMMARY_FORMATS, "How long the summary is. Defaults to medium."),
        },
        ["call_id"],
      ),
      (args) => ({
        path: `/call/${requiredId(args, "call_id")}/ai_recap`,
        query: { summary_format: oneOf(args, "format", SUMMARY_FORMATS) },
      }),
    ),
    tool(
      "send_sms",
      "SENDS A REAL TEXT MESSAGE from Dialpad to up to 10 phone numbers. Confirm the recipients and text with the user first. Sends from user_id or from_number; a company API key needs one of them.",
      object(
        {
          to_numbers: strings("Recipients in E.164 format, such as +14155551234. At most 10."),
          text: string("The message."),
          user_id: id("The Dialpad user it is sent as."),
          from_number: string("Send from this Dialpad number instead; it overrides user_id."),
          sender_group_id: id("Send as this office, department, or call center."),
          sender_group_type: choice(GROUP_TYPES, "The kind of group sender_group_id is."),
        },
        ["to_numbers", "text"],
      ),
      (args) => {
        const to = optionalStrings(args, "to_numbers") ?? [];
        if (to.length === 0 || to.length > 10) {
          throw new ToolError("to_numbers needs between 1 and 10 phone numbers.");
        }
        const userId = optionalId(args, "user_id");
        const groupId = optionalId(args, "sender_group_id");
        return {
          method: "POST",
          path: "/sms",
          body: withoutUndefined({
            to_numbers: to,
            text: requiredString(args, "text"),
            user_id: userId ? idValue(userId) : undefined,
            from_number: optionalString(args, "from_number"),
            sender_group_id: groupId ? idValue(groupId) : undefined,
            sender_group_type: oneOf(args, "sender_group_type", GROUP_TYPES),
          }),
        };
      },
    ),
    tool(
      "list_contacts",
      "List the company's shared Dialpad contacts, or a user's own contacts with owner_id. Filter by name; Dialpad has no phone or email search.",
      object({
        name: string("Only contacts whose name matches."),
        owner_id: USER_ID,
        include_local: boolean("Include users' own contacts along with shared ones."),
        cursor: CURSOR,
      }),
      (args) => ({
        path: "/contacts",
        query: {
          name: optionalString(args, "name"),
          owner_id: optionalId(args, "owner_id"),
          include_local: optionalBoolean(args, "include_local"),
          cursor: optionalString(args, "cursor"),
        },
      }),
    ),
    tool(
      "get_contact",
      "Get one Dialpad contact.",
      object({ contact_id: string("The contact's id, from list_contacts.") }, ["contact_id"]),
      (args) => ({
        path: `/contacts/${encodeURIComponent(requiredString(args, "contact_id"))}`,
      }),
    ),
    tool(
      "create_contact",
      "Add a contact to Dialpad: shared with the company, or one user's own with owner_id.",
      object({ ...contactFields, owner_id: USER_ID }, ["first_name", "last_name"]),
      (args) => {
        requiredString(args, "first_name");
        requiredString(args, "last_name");
        return {
          method: "POST",
          path: "/contacts",
          body: {
            ...contactBody(args),
            ...withoutUndefined({ owner_id: optionalId(args, "owner_id") }),
          },
        };
      },
    ),
    tool(
      "update_contact",
      "Change a Dialpad contact. Only the fields given change; a list given replaces the whole list.",
      object({ contact_id: string("The contact's id, from list_contacts."), ...contactFields }, [
        "contact_id",
      ]),
      (args) => {
        const body = contactBody(args);
        if (Object.keys(body).length === 0)
          throw new ToolError("Give at least one field to change.");
        return {
          method: "PATCH",
          path: `/contacts/${encodeURIComponent(requiredString(args, "contact_id"))}`,
          body,
        };
      },
    ),
    tool(
      "place_call",
      "PLACES A REAL PHONE CALL. Rings the user's Dialpad apps and phones, then dials the number once they answer. Confirm with the user first. The user needs Dialpad open or a desk phone; Dialpad allows 5 of these a minute.",
      object(
        {
          phone_number: string("The number to call, in E.164 format, such as +14155551234."),
          user_id: id("The Dialpad user whose devices ring."),
          outbound_caller_id: string(
            'The number the other side sees, in E.164 format, or "blocked". Defaults to the user\'s number.',
          ),
          device_id: string("Ring only this one of the user's devices."),
          group_id: id("Call on behalf of this office, department, or call center."),
          group_type: choice(GROUP_TYPES, "The kind of group group_id is."),
        },
        ["phone_number", "user_id"],
      ),
      (args) => {
        const groupId = optionalId(args, "group_id");
        return {
          method: "POST",
          path: "/call",
          body: withoutUndefined({
            phone_number: requiredString(args, "phone_number"),
            user_id: idValue(requiredId(args, "user_id")),
            outbound_caller_id: optionalString(args, "outbound_caller_id"),
            device_id: optionalString(args, "device_id"),
            group_id: groupId ? idValue(groupId) : undefined,
            group_type: oneOf(args, "group_type", GROUP_TYPES),
          }),
        };
      },
    ),
  ];

  return {
    name: "Dialpad",
    // A user API key can read itself; a company API key can read the company.
    check: async (signal) => {
      try {
        await api({ path: "/users/me" }, signal);
      } catch (error) {
        if (!(error instanceof ToolError) || error.message.startsWith("Dialpad refused")) {
          throw error;
        }
        await api({ path: "/company" }, signal);
      }
    },
    tools,
  };
}
