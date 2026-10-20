import { describe, expect, it } from "vite-plus/test";
import { PetId, ThreadId, type BotProfile, type Pet } from "@mybot/contracts";

import { PetMoodTracker, petPoseFor, resolveBotPet, resolvePetMood } from "./petMood.ts";

type MoodInput = Parameters<typeof resolvePetMood>[0];

const thread = (
  status: string,
  extra: {
    lastErrorClass?: string;
    approvals?: boolean;
    input?: boolean;
    run?: string;
  } = {},
) =>
  ({
    runtime: { status, lastError: null, lastErrorClass: extra.lastErrorClass ?? null },
    hasPendingApprovals: extra.approvals ?? false,
    hasPendingUserInput: extra.input ?? false,
    latestRun: extra.run ? { status: extra.run } : null,
  }) as unknown as MoodInput;

describe("resolvePetMood", () => {
  it("puts pending approvals and input first", () => {
    expect(resolvePetMood(thread("running", { approvals: true }))).toBe("needs-you");
    expect(resolvePetMood(thread("idle", { input: true }))).toBe("needs-you");
  });
  it("treats active runtime statuses as working", () => {
    for (const s of ["preparing", "queued", "starting", "running", "waiting"]) {
      expect(resolvePetMood(thread(s))).toBe("working");
    }
  });
  it("splits failures by usage limit", () => {
    expect(resolvePetMood(thread("failed", { lastErrorClass: "usage_limit" }))).toBe("limited");
    expect(resolvePetMood(thread("failed", { lastErrorClass: "provider_error" }))).toBe("failed");
    expect(resolvePetMood(thread("failed"))).toBe("failed");
  });
  it("completes only on a completed latest run", () => {
    expect(resolvePetMood(thread("completed", { run: "completed" }))).toBe("completed");
    expect(resolvePetMood(thread("idle", { run: "completed" }))).toBe("completed");
  });
  it("falls back to idle", () => {
    expect(resolvePetMood(thread("interrupted", { run: "interrupted" }))).toBe("idle");
    expect(resolvePetMood(thread("cancelled", { run: "cancelled" }))).toBe("idle");
    expect(resolvePetMood(thread("idle"))).toBe("idle");
    expect(resolvePetMood({ ...thread("idle"), runtime: null } as unknown as MoodInput)).toBe(
      "idle",
    );
  });
});

describe("petPoseFor", () => {
  it("loops running while working", () => {
    for (const t of [true, false]) {
      expect(petPoseFor("working", t)).toMatchObject({ row: "running", loop: true });
    }
  });
  it("waves a waiting bubble on transition and holds it otherwise", () => {
    expect(petPoseFor("needs-you", true)).toMatchObject({
      row: "waiting",
      plays: 3,
      holdLastFrame: true,
      bubble: "Needs you",
    });
    expect(petPoseFor("needs-you", false)).toMatchObject({
      row: "waiting",
      plays: 0,
      holdLastFrame: true,
      bubble: "Needs you",
    });
    expect(petPoseFor("limited", true)).toMatchObject({ plays: 3, bubble: "Limit reached" });
    expect(petPoseFor("limited", false)).toMatchObject({ plays: 0, bubble: "Limit reached" });
  });
  it("plays failed twice then holds", () => {
    expect(petPoseFor("failed", true)).toMatchObject({
      row: "failed",
      plays: 2,
      holdLastFrame: true,
      bubble: "Failed",
    });
    expect(petPoseFor("failed", false)).toMatchObject({
      row: "failed",
      plays: 0,
      holdLastFrame: true,
    });
  });
  it("jumps once on completion, else idles", () => {
    expect(petPoseFor("completed", true)).toMatchObject({
      row: "jumping",
      plays: 1,
      returnToIdleAfterMs: 4000,
    });
    expect(petPoseFor("completed", false)).toMatchObject({ row: "idle", plays: 0, loop: false });
  });
  it("holds idle frame 0", () => {
    expect(petPoseFor("idle", true)).toMatchObject({ row: "idle", plays: 0, loop: false });
  });
});

describe("PetMoodTracker", () => {
  const a = ThreadId.make("a");
  const b = ThreadId.make("b");
  it("does not react to a thread first seen as failed", () => {
    expect(new PetMoodTracker().observe(a, "failed").plays).toBe(0);
  });
  it("reacts when the same thread changes mood", () => {
    const t = new PetMoodTracker();
    t.observe(a, "working");
    expect(t.observe(a, "failed").plays).toBe(2);
    expect(t.observe(a, "failed").plays).toBe(0);
  });
  it("does not react when switching threads and back", () => {
    const t = new PetMoodTracker();
    t.observe(a, "failed");
    t.observe(b, "failed");
    expect(t.observe(a, "failed").plays).toBe(0);
  });
});

describe("resolveBotPet", () => {
  const pet = (id: string) => ({ id: PetId.make(id) }) as unknown as Pet;
  const pets = [pet("fox"), pet("cat")];
  const bot = (petId?: string | null) =>
    (petId === undefined ? {} : { petId: petId === null ? null : PetId.make(petId) }) as BotProfile;
  const def = PetId.make("cat");
  it("uses the explicit pet", () => {
    expect(resolveBotPet({ bot: bot("fox"), defaultPetId: def, pets })?.id).toBe("fox");
  });
  it("shows nothing for explicit null", () => {
    expect(resolveBotPet({ bot: bot(null), defaultPetId: def, pets })).toBeNull();
  });
  it("uses the default when absent or dangling", () => {
    expect(resolveBotPet({ bot: bot(), defaultPetId: def, pets })?.id).toBe("cat");
    expect(resolveBotPet({ bot: bot("gone"), defaultPetId: def, pets })?.id).toBe("cat");
  });
  it("returns null with a dangling id and no usable default", () => {
    expect(resolveBotPet({ bot: bot("gone"), defaultPetId: null, pets })).toBeNull();
    expect(resolveBotPet({ bot: bot("gone"), defaultPetId: PetId.make("nope"), pets })).toBeNull();
  });
  it("returns null for a non-bot", () => {
    expect(resolveBotPet({ bot: null, defaultPetId: def, pets })).toBeNull();
    expect(resolveBotPet({ bot: undefined, defaultPetId: def, pets })).toBeNull();
  });
});
