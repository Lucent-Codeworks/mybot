import type { BotProfile, Pet, PetId, PetRowName, ThreadId } from "@mybot/contracts";

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

/**
 * Tracks the last mood per thread so a reaction plays only when a thread
 * visibly changes state, not when it is first shown or switched to.
 */
export class PetMoodTracker {
  private readonly moods = new Map<ThreadId, PetMood>();

  observe(threadId: ThreadId, mood: PetMood): PetPose {
    const previous = this.moods.get(threadId);
    this.moods.set(threadId, mood);
    return petPoseFor(mood, previous !== undefined && previous !== mood);
  }
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
