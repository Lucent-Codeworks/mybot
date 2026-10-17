import { OrchestratorMcpFailure } from "@mybot/contracts";
import * as Effect from "effect/Effect";

import * as BotMessaging from "../../../bots/BotMessaging.ts";
import * as GuideImport from "../../../bots/GuideImport.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { BotsToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(BotsToolkit, {
  // It starts work as another bot, so like delegating it needs a live bot thread as the caller.
  bot_message: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller } = yield* loadCaller();
      if (caller === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "thread_credential_required",
          message: "bot_message needs an agent running in a bot's conversation.",
        });
      const messaging = yield* BotMessaging.BotMessaging;
      return yield* messaging
        .send({
          sender: {
            threadId: caller.id,
            projectId: caller.projectId,
            runtimeMode: caller.runtimeMode,
            interactionMode: caller.interactionMode,
            modelSelection: caller.modelSelection,
          },
          to: input.to,
          message: input.message,
          wait: input.wait ?? true,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
    }),
  ),
  // It writes into the shared skills folder for the calling bot, so it needs a live bot thread.
  skill_import_guide: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { caller } = yield* loadCaller();
      if (caller === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "thread_credential_required",
          message: "skill_import_guide needs an agent running in a bot's conversation.",
        });
      const guides = yield* GuideImport.GuideImport;
      return yield* guides
        .importGuide({ projectId: caller.projectId, path: input.path, skill: input.skill })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
    }),
  ),
});
