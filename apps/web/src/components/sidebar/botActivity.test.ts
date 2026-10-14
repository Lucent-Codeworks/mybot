import { describe, expect, it } from "vite-plus/test";

import { resolveBotActivity } from "./botActivity";

const bots = [
  { projectKey: "scout", memberProjectRefs: [{ environmentId: "env", projectId: "p-scout" }] },
  { projectKey: "inbox", memberProjectRefs: [{ environmentId: "env", projectId: "p-inbox" }] },
];
const thread = (projectId: string, overrides: object = {}) =>
  ({
    environmentId: "env",
    projectId,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    ...overrides,
  }) as never;

describe("resolveBotActivity", () => {
  it("prefers a conversation that waits on the user over one that is working", () => {
    const activity = resolveBotActivity(bots, [
      thread("p-scout", { runtime: { status: "running" } }),
      thread("p-scout", { hasPendingApprovals: true }),
      thread("p-scout", { runtime: { status: "running" } }),
      thread("p-inbox", { runtime: { status: "running" } }),
      thread("p-plain", { hasPendingUserInput: true }),
    ]);
    expect(Object.fromEntries(activity)).toEqual({ scout: "needs-you", inbox: "working" });
  });

  it("shows nothing for idle bots", () => {
    expect(resolveBotActivity(bots, [thread("p-scout")]).size).toBe(0);
  });
});
