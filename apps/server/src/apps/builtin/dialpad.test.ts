import { describe, expect, it } from "vite-plus/test";

import { dialpadApp, parseDialpadJson } from "./dialpad.ts";
import { DIALPAD_OPERATIONS } from "./dialpadApi.gen.ts";
import { builtinSession } from "./index.ts";

interface Sent {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | null;
  readonly body: unknown;
}

/** A fake Dialpad: answers each path from `routes`, 404 otherwise, and records requests. */
const fakeDialpad = (routes: Record<string, { status?: number; body: string }>) => {
  const sent: Array<Sent> = [];
  const fetch = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    sent.push({
      method: init.method ?? "GET",
      url,
      authorization: new Headers(init.headers).get("authorization"),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const route = routes[`${init.method ?? "GET"} ${url.pathname}`];
    return new Response(route?.body ?? '{"error":{"message":"nope"}}', {
      status: route ? (route.status ?? 200) : 404,
    });
  };
  return { app: dialpadApp("key-1", { fetch }), sent };
};

const signal = new AbortController().signal;
const call = async (
  app: ReturnType<typeof dialpadApp>,
  name: string,
  args: Record<string, unknown>,
) => {
  const session = builtinSession(app);
  return session.request("tools/call", { name, arguments: args }, { timeoutMs: 5_000 });
};
const textOf = (result: Record<string, unknown>) =>
  (result.content as ReadonlyArray<{ text: string }>)[0]!.text;

describe("parseDialpadJson", () => {
  it("keeps 64-bit ids exact and leaves other numbers alone", () => {
    expect(parseDialpadJson('{"call_id": 9007199254740993, "duration": 1.5, "n": 42}')).toEqual({
      call_id: "9007199254740993",
      duration: 1.5,
      n: 42,
    });
  });
});

describe("the Dialpad app", () => {
  it("accepts a user API key and sends it as a bearer token", async () => {
    const { app, sent } = fakeDialpad({ "GET /api/v2/users/me": { body: '{"id": 1}' } });
    await app.check(signal);
    expect(sent.map((request) => request.authorization)).toEqual(["Bearer key-1"]);
  });

  it("falls back to the company for a company API key", async () => {
    const { app, sent } = fakeDialpad({
      "GET /api/v2/users/me": { status: 400, body: '{"error":{"message":"no user"}}' },
      "GET /api/v2/company": { body: '{"id": 2}' },
    });
    await app.check(signal);
    expect(sent.map((request) => request.url.pathname)).toEqual([
      "/api/v2/users/me",
      "/api/v2/company",
    ]);
  });

  it("refuses to connect with a wrong key", async () => {
    const { app, sent } = fakeDialpad({ "GET /api/v2/users/me": { status: 401, body: "" } });
    await expect(app.check(signal)).rejects.toThrow("Dialpad refused the API key");
    expect(sent).toHaveLength(1);
  });

  it("lists calls between ISO times as epoch milliseconds", async () => {
    const { app, sent } = fakeDialpad({ "GET /api/v2/call": { body: '{"items": []}' } });
    const result = await call(app, "list_calls", {
      started_after: "2026-10-01T00:00:00Z",
      target_type: "user",
      target_id: "9007199254740993",
    });
    expect(result.isError).toBeUndefined();
    expect(Object.fromEntries(sent[0]!.url.searchParams)).toEqual({
      started_after: String(Date.parse("2026-10-01T00:00:00Z")),
      target_type: "user",
      target_id: "9007199254740993",
    });
  });

  it("returns only spoken lines of a transcript", async () => {
    const { app } = fakeDialpad({
      "GET /api/v2/transcripts/7": {
        body: JSON.stringify({
          call_id: 7,
          lines: [
            { type: "transcript", time: "t1", name: "Ana", content: "Hi" },
            { type: "moment", time: "t2", name: "AI", content: "greeting" },
          ],
        }),
      },
    });
    const result = await call(app, "get_call_transcript", { call_id: 7 });
    expect(JSON.parse(textOf(result))).toEqual({
      call_id: 7,
      lines: [{ time: "t1", name: "Ana", text: "Hi" }],
    });
  });

  it("sends a text with numeric ids that fit and digits that do not", async () => {
    const { app, sent } = fakeDialpad({ "POST /api/v2/sms": { body: '{"id": 1}' } });
    await call(app, "send_sms", {
      to_numbers: ["+14155551234"],
      text: "Hello",
      user_id: "12",
      sender_group_id: "9007199254740993",
      sender_group_type: "office",
    });
    expect(sent[0]!.body).toEqual({
      to_numbers: ["+14155551234"],
      text: "Hello",
      user_id: 12,
      sender_group_id: "9007199254740993",
      sender_group_type: "office",
    });
  });

  it("tells the bot what is wrong instead of calling Dialpad", async () => {
    const { app, sent } = fakeDialpad({});
    const tooMany = await call(app, "send_sms", {
      to_numbers: Array.from({ length: 11 }, (_, index) => `+1415555${1000 + index}`),
      text: "Hi",
    });
    expect(tooMany.isError).toBe(true);
    expect(textOf(tooMany)).toContain("between 1 and 10");
    const noChange = await call(app, "update_contact", { contact_id: "c1" });
    expect(textOf(noChange)).toContain("at least one field");
    expect(sent).toHaveLength(0);
  });

  it("reports Dialpad's refusal to the bot", async () => {
    const { app } = fakeDialpad({
      "POST /api/v2/call": { status: 429, body: '{"error":{"message":"slow down"}}' },
    });
    const result = await call(app, "place_call", { phone_number: "+14155551234", user_id: 3 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("rate limit");
  });

  it("lists the hand-written tools, then one tool per other API operation", async () => {
    const { app } = fakeDialpad({});
    const listed = await builtinSession(app).request("tools/list", {}, { timeoutMs: 5_000 });
    const tools = listed.tools as ReadonlyArray<{ name: string; inputSchema: { type: string } }>;
    expect(tools.slice(0, 11).map((tool) => tool.name)).toEqual([
      "list_users",
      "list_calls",
      "get_call",
      "get_call_transcript",
      "get_call_summary",
      "send_sms",
      "list_contacts",
      "get_contact",
      "create_contact",
      "update_contact",
      "place_call",
    ]);
    expect(tools.length).toBe(11 + DIALPAD_OPERATIONS.length);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    for (const tool of tools) expect(tool.inputSchema.type, tool.name).toBe("object");
  });

  it("runs a generated operation with a 64-bit id in its path", async () => {
    const { app, sent } = fakeDialpad({
      "PUT /api/v2/call/9007199254740993/actions/hangup": { body: '{"id": 9007199254740993}' },
    });
    const result = await call(app, "call_hangup", { id: "9007199254740993" });
    expect(sent[0]!.method).toBe("PUT");
    expect(JSON.parse(textOf(result))).toEqual({ id: "9007199254740993" });
  });

  it("sends a generated operation's body with every digit of its ids", async () => {
    const sentBodies: Array<string> = [];
    const app = dialpadApp("key-1", {
      fetch: async (_input, init) => {
        sentBodies.push(String(init.body));
        return new Response("{}");
      },
    });
    await call(app, "users_update", {
      id: "me",
      body: { first_name: "Ana", admin_office_ids: ["9007199254740993", 12] },
    });
    expect(sentBodies).toEqual(['{"first_name":"Ana","admin_office_ids":[9007199254740993,12]}']);
  });

  it("tells the bot about a missing or misplaced argument before calling Dialpad", async () => {
    const { app, sent } = fakeDialpad({});
    expect(textOf(await call(app, "call_hangup", {}))).toBe("Missing id.");
    expect(textOf(await call(app, "users_update", { id: "me", first_name: "Ana" }))).toBe(
      "Unknown argument first_name. Request fields go in body.",
    );
    expect(textOf(await call(app, "call_hangup", { id: "abc" }))).toContain("digits");
    expect(sent).toHaveLength(0);
  });
});
