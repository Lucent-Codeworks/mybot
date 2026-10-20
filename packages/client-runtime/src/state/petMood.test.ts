import { describe, expect, it } from "vite-plus/test";
import { PetId, type BotProfile, type Pet } from "@mybot/contracts";

import {
  nextThreadPose,
  petPoseFor,
  resolveBotPet,
  resolvePetMood,
  unknownBotPetIds,
} from "./petMood.ts";

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
  });
  it("rests while background work holds a finished run open", () => {
    // Runtime "idle" is the sidebar's grey "waiting": subagents or monitors will wake the agent.
    expect(resolvePetMood(thread("idle", { run: "completed" }))).toBe("idle");
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

describe("nextThreadPose", () => {
  it("does not react to a thread's first mood", () => {
    const first = nextThreadPose(null, "env:a", "failed");
    expect(first).toMatchObject({ threadKey: "env:a", mood: "failed" });
    expect(first.pose.plays).toBe(0);
  });
  it("reacts when the same thread changes mood", () => {
    const working = nextThreadPose(null, "env:a", "working");
    expect(nextThreadPose(working, "env:a", "failed").pose.plays).toBe(2);
  });
  it("does not react when switching threads", () => {
    const working = nextThreadPose(null, "env:a", "working");
    expect(nextThreadPose(working, "env:b", "failed").pose.plays).toBe(0);
    const failedA = nextThreadPose(null, "env:a", "failed");
    const failedB = nextThreadPose(failedA, "env:b", "failed");
    expect(failedB.threadKey).toBe("env:b");
    expect(nextThreadPose(failedB, "env:a", "failed").pose.plays).toBe(0);
  });
  it("returns the same object while nothing changes", () => {
    const working = nextThreadPose(null, "env:a", "working");
    const failed = nextThreadPose(working, "env:a", "failed");
    expect(nextThreadPose(failed, "env:a", "failed")).toBe(failed);
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

describe("unknownBotPetIds", () => {
  const pet = (id: string) => ({ id: PetId.make(id) }) as unknown as Pet;
  const pets = [pet("fox"), pet("cat")];
  const bot = (petId?: string | null) =>
    (petId === undefined ? {} : { petId: petId === null ? null : PetId.make(petId) }) as BotProfile;
  it("is empty when the pet in use is known", () => {
    expect(unknownBotPetIds({ bot: bot("fox"), defaultPetId: PetId.make("gone"), pets })).toEqual(
      [],
    );
    expect(unknownBotPetIds({ bot: bot(), defaultPetId: PetId.make("cat"), pets })).toEqual([]);
  });
  it("names a bot pet the list has not seen", () => {
    expect(unknownBotPetIds({ bot: bot("new"), defaultPetId: PetId.make("cat"), pets })).toEqual([
      "new",
    ]);
  });
  it("names a default the list has not seen, alone or behind a dangling bot pet", () => {
    expect(unknownBotPetIds({ bot: bot(), defaultPetId: PetId.make("new"), pets })).toEqual([
      "new",
    ]);
    expect(unknownBotPetIds({ bot: bot("gone"), defaultPetId: PetId.make("new"), pets })).toEqual([
      "gone",
      "new",
    ]);
  });
  it("is empty for an opted-out bot, a non-bot, or no default", () => {
    expect(unknownBotPetIds({ bot: bot(null), defaultPetId: PetId.make("new"), pets })).toEqual([]);
    expect(unknownBotPetIds({ bot: null, defaultPetId: PetId.make("new"), pets })).toEqual([]);
    expect(unknownBotPetIds({ bot: bot(), defaultPetId: null, pets })).toEqual([]);
  });
});
