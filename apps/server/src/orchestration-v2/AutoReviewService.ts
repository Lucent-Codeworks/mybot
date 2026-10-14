import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/** Requests a reviewer may approve: the agent wants to act, not to ask the user something. */
const REVIEWABLE_KINDS: ReadonlySet<OrchestrationV2RuntimeRequest["kind"]> = new Set([
  "command",
  "file-read",
  "file-change",
  "permission",
]);

/** Whether a stored event is a new approval request that Auto Review should look at. */
export function isReviewableRequest(
  event: OrchestrationV2DomainEvent,
): event is Extract<OrchestrationV2DomainEvent, { readonly type: "runtime-request.updated" }> {
  return (
    event.type === "runtime-request.updated" &&
    event.payload.status === "pending" &&
    REVIEWABLE_KINDS.has(event.payload.kind)
  );
}

/**
 * Auto Review for bots that turn it on: a reviewer model looks at each
 * approval request and approves the clearly safe ones. Anything else stays
 * pending for the user, in MyBot or on Telegram; the reviewer never declines.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const textGeneration = yield* TextGeneration.TextGeneration;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const seen = new Set<string>();

    const review = Effect.fn("AutoReview.review")(function* (
      threadId: ThreadId,
      request: OrchestrationV2RuntimeRequest,
    ) {
      const thread = yield* orchestrator.getThreadShell(threadId);
      if (thread === null) return;
      const project = Option.getOrUndefined(yield* projects.getShell(thread.projectId));
      if (!project?.bot?.autoReview) return;
      const records = yield* threads.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["approval_request"],
      });
      const item = records.turnItems.find(
        (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
      );
      if (item?.type !== "approval_request") return;
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        project.id,
        project,
      ).settings;
      const verdict = yield* textGeneration.reviewAction({
        cwd: project.workspaceRoot,
        action: [`Kind: ${item.requestKind}`, item.title, item.prompt].filter(Boolean).join("\n"),
        rules: project.bot.instructions,
        modelSelection: settings.textGenerationModelSelection ?? thread.modelSelection,
      });
      yield* Effect.logInfo("Auto Review verdict", {
        threadId,
        requestId: request.id,
        verdict: verdict.verdict,
        reason: verdict.reason,
      });
      if (verdict.verdict !== "allow") return;
      yield* threads.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`auto-review:${request.id}`),
        threadId,
        requestId: request.id,
        decision: "accept",
      });
    });

    yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(isReviewableRequest),
      Stream.runForEach((event) => {
        if (seen.has(event.payload.id)) return Effect.void;
        seen.add(event.payload.id);
        return review(event.threadId, event.payload).pipe(
          // A failed review leaves the request for the user, as if it said ask.
          Effect.catchCause((cause) => Effect.logWarning("Auto Review failed.", { cause })),
          Effect.forkDetach,
          Effect.asVoid,
        );
      }),
      Effect.catchCause((cause) => Effect.logWarning("Auto Review stopped.", { cause })),
      Effect.forkScoped,
    );
  }),
);
