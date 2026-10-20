import type { BotProfile, Pet, PetId, PetRowName } from "@mybot/contracts";

import type { EnvironmentThreadShell } from "./models.ts";

export type PetMood = "idle" | "working" | "needs-you" | "limited" | "failed" | "completed";

/**
 * How a pet plays its atlas row. `plays: 0` with `holdLastFrame` shows the
 * row's last frame still; `plays: 0` otherwise shows frame 0. Only `loop`
 * poses repeat, so nothing repaints once a reaction has finished.
 */
export type PetPose = {
  readonly row: PetRowName;
  readonly loop: boolean;
  readonly plays: number;
  readonly holdLastFrame: boolean;
  readonly returnToIdleAfterMs?: number;
  readonly bubble?: "Needs you" | "Limit reached" | "Failed";
};

const WORKING_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export function resolvePetMood(
  thread: Pick<
    EnvironmentThreadShell,
    "runtime" | "hasPendingApprovals" | "hasPendingUserInput" | "latestRun"
  >,
): PetMood {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "needs-you";
  const status = thread.runtime?.status;
  if (status !== undefined && WORKING_STATUSES.has(status)) return "working";
  if (status === "failed") {
    return thread.runtime?.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  // Runtime "idle" means background work (subagents, monitors) will wake the
  // agent; the sidebar shows it as waiting, so the pet rests instead of celebrating.
  if (status === "idle") return "idle";
  if (thread.latestRun?.status === "completed") return "completed";
  return "idle";
}

const IDLE_POSE: PetPose = { row: "idle", loop: false, plays: 0, holdLastFrame: false };

export function petPoseFor(mood: PetMood, transitioned: boolean): PetPose {
  switch (mood) {
    case "working":
      return { row: "running", loop: true, plays: 0, holdLastFrame: false };
    case "needs-you":
    case "limited":
      return {
        row: "waiting",
        loop: false,
        plays: transitioned ? 3 : 0,
        holdLastFrame: true,
        bubble: mood === "needs-you" ? "Needs you" : "Limit reached",
      };
    case "failed":
      return {
        row: "failed",
        loop: false,
        plays: transitioned ? 2 : 0,
        holdLastFrame: true,
        bubble: "Failed",
      };
    case "completed":
      return transitioned
        ? {
            row: "jumping",
            loop: false,
            plays: 1,
            holdLastFrame: false,
            returnToIdleAfterMs: 4000,
          }
        : IDLE_POSE;
    case "idle":
      return IDLE_POSE;
  }
}

/** The pose a surface shows for the thread it is displaying. */
export type ThreadPose = {
  readonly threadKey: string | null;
  readonly mood: PetMood;
  readonly pose: PetPose;
};

/**
 * The next pose for the displayed thread. A reaction plays only when the
 * same thread's mood changes; a first look or a thread switch starts from the
 * resting pose, so nothing replays. Returns `previous` itself while nothing
 * changed, so callers can store it in state without a render loop.
 */
export function nextThreadPose(
  previous: ThreadPose | null,
  threadKey: string | null,
  mood: PetMood,
): ThreadPose {
  if (previous?.threadKey === threadKey && previous.mood === mood) return previous;
  return { threadKey, mood, pose: petPoseFor(mood, previous?.threadKey === threadKey) };
}

/**
 * The pet a bot shows: its own choice, else the default. `petId: null` means
 * the bot opted out; a dangling id falls back to the default.
 */
export function resolveBotPet(input: {
  readonly bot: BotProfile | null | undefined;
  readonly defaultPetId: PetId | null;
  readonly pets: ReadonlyArray<Pet>;
}): Pet | null {
  const { bot, defaultPetId, pets } = input;
  if (!bot || bot.petId === null) return null;
  const find = (id: PetId | null | undefined) =>
    id === null || id === undefined ? null : (pets.find((pet) => pet.id === id) ?? null);
  return find(bot.petId) ?? find(defaultPetId);
}

/**
 * The pet ids `resolveBotPet` would try that `pets` does not hold, in order.
 * Pets are managed on other devices and the default can change elsewhere, so
 * a surface refreshes its list once for each new answer here.
 */
export function unknownBotPetIds(input: {
  readonly bot: BotProfile | null | undefined;
  readonly defaultPetId: PetId | null;
  readonly pets: ReadonlyArray<Pet>;
}): ReadonlyArray<PetId> {
  const { bot, defaultPetId, pets } = input;
  if (!bot || bot.petId === null) return [];
  const unknown: Array<PetId> = [];
  for (const id of [bot.petId, defaultPetId]) {
    if (id === null || id === undefined) continue;
    if (pets.some((pet) => pet.id === id)) break;
    unknown.push(id);
  }
  return unknown;
}
