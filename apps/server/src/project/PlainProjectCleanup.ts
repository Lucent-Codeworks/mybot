/**
 * PlainProjectCleanup - keeps the invariant that every MyBot project is a bot.
 *
 * Plain projects (no bot profile) come from before MyBot, the old "No project"
 * Scratch project, or an explicitly enabled cwd auto-bootstrap. On every start,
 * once the server accepts commands, each one is deleted with its threads.
 * ProjectService.delete only writes MyBot's database; the project's folder and
 * files are never touched.
 *
 * @module PlainProjectCleanup
 */
import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ProjectService from "./ProjectService.ts";

/**
 * Deletes every active project without a bot, threads included, and returns how
 * many it deleted. The command id is fixed per project, so a run that failed
 * midway resumes the same deletion. One project's failure is logged and skipped.
 */
export const removePlainProjects = Effect.fn("PlainProjectCleanup.removePlainProjects")(
  function* () {
    const projects = yield* ProjectService.ProjectService;
    const shells = yield* projects.listShells();
    let removed = 0;
    for (const shell of shells) {
      if (shell.bot != null) continue;
      const deleted = yield* projects
        .delete({
          commandId: CommandId.make(`remove-plain-project:${shell.id}`),
          projectId: shell.id,
          force: true,
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to remove a plain project.", {
              projectId: shell.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
      if (deleted) removed++;
    }
    if (removed > 0) yield* Effect.logInfo("Removed plain projects.", { count: removed });
    return removed;
  },
);

/** Runs the cleanup in the background once startup has finished its own project work. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const projects = yield* ProjectService.ProjectService;
    yield* startup.awaitCommandReady.pipe(
      Effect.andThen(removePlainProjects()),
      Effect.provideService(ProjectService.ProjectService, projects),
      Effect.catchCause((cause) =>
        Effect.logWarning("Plain project cleanup did not run.", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
);
