/**
 * BuiltInMyBot - the one MyBot bot (`bot.orchestrator`) that routes the user's
 * requests to their other bots.
 *
 * It is created on startup when missing, can't be deleted, and keeps its flag
 * through every update; no other bot can take the flag. Entry points that
 * delete or edit projects (RPC, HTTP, CLI, MCP) apply these guards.
 *
 * @module BuiltInMyBot
 */
import type { BotProfile, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";

type ProjectReads = Pick<ProjectService.ProjectService["Service"], "getById">;

/** Refuses deleting the built-in MyBot. */
export const assertDeletable = Effect.fn("BuiltInMyBot.assertDeletable")(function* (
  projects: ProjectReads,
  projectId: ProjectId,
) {
  const project = Option.getOrUndefined(yield* projects.getById(projectId));
  if (project?.bot?.orchestrator === true)
    return yield* new ProjectService.ProjectBuiltInError({ projectId, reason: "delete" });
});

/**
 * The profile an update writes. The built-in MyBot keeps its flag even when
 * the update leaves it out; any other bot asking for it is refused.
 */
export const guardedBotProfile = Effect.fn("BuiltInMyBot.guardedBotProfile")(function* <
  B extends BotProfile | null | undefined,
>(projects: ProjectReads, projectId: ProjectId, bot: B) {
  if (bot == null) return bot;
  const existing = Option.getOrUndefined(yield* projects.getById(projectId))?.bot;
  if (existing?.orchestrator === true) return { ...bot, orchestrator: true } as B;
  if (bot.orchestrator === true)
    return yield* new ProjectService.ProjectBuiltInError({ projectId, reason: "orchestrator" });
  const { orchestrator: _flag, ...profile } = bot;
  return profile as B;
});

/** A new bot's profile without the orchestrator flag, which only startup sets. */
export function withoutOrchestrator(bot: BotProfile): BotProfile;
export function withoutOrchestrator(
  bot: BotProfile | null | undefined,
): BotProfile | null | undefined;
export function withoutOrchestrator(bot: BotProfile | null | undefined) {
  if (bot == null || bot.orchestrator === undefined) return bot;
  const { orchestrator: _flag, ...profile } = bot;
  return profile;
}

/** Creates the built-in MyBot unless one exists; returns its project id. */
export const ensureBuiltInMyBot = Effect.fn("BuiltInMyBot.ensure")(function* () {
  const projects = yield* ProjectService.ProjectService;
  const existing = (yield* projects.listShells()).filter(
    (shell) => shell.bot?.orchestrator === true,
  );
  if (existing.length > 1)
    yield* Effect.logWarning("More than one built-in MyBot exists.", {
      projectIds: existing.map((shell) => shell.id),
    });
  if (existing[0] !== undefined) return existing[0].id;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  // No model override, so it follows the user's default model.
  const created = yield* folders.createNamedProject({
    name: "MyBot",
    bot: { role: "Your assistant", instructions: "", orchestrator: true },
    projectIcon: { kind: "lucide", name: "sparkles", color: "violet" },
  });
  yield* Effect.logInfo("Created the built-in MyBot.", { projectId: created.projectId });
  return created.projectId;
});

/** Makes sure the built-in MyBot exists, in the background once the server accepts commands. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const services = yield* Effect.context<
      ProjectService.ProjectService | ManagedProjectFolders.ManagedProjectFolders
    >();
    yield* startup.awaitCommandReady.pipe(
      Effect.andThen(ensureBuiltInMyBot()),
      Effect.provide(services),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not create the built-in MyBot.", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
);
