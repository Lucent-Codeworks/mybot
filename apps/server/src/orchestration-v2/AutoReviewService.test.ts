import { assert, it } from "@effect/vitest";
import {
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as AutoReviewService from "./AutoReviewService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const reviewedBot = ProjectId.make("project-reviewed");
const plainBot = ProjectId.make("project-plain");
const threadFor = {
  [reviewedBot]: ThreadId.make("thread-reviewed"),
  [plainBot]: ThreadId.make("thread-plain"),
};

const approval = (projectId: ProjectId, requestId: string, title: string) =>
  ({
    type: "runtime-request.updated",
    threadId: threadFor[projectId],
    payload: { id: RuntimeRequestId.make(requestId), kind: "command", status: "pending", title },
  }) as unknown as OrchestrationV2DomainEvent;

it.effect("approves the safe actions of bots with Auto Review and leaves the rest", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const reviewed: Array<string> = [];
    const askReviewed = yield* Deferred.make<void>();
    const dispatched = yield* Deferred.make<unknown>();
    const layer = AutoReviewService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
            getThreadShell: (threadId) =>
              Effect.succeed({
                id: threadId,
                projectId: threadId === threadFor[plainBot] ? plainBot : reviewedBot,
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
              } as never),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            getShell: (projectId) =>
              Effect.succeed(
                Option.some({
                  id: projectId,
                  workspaceRoot: "/bots/x",
                  bot: {
                    role: "",
                    instructions: "Never touch production.",
                    autoReview: projectId === reviewedBot,
                  },
                } as OrchestrationProjectShell),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Effect.succeed({
                turnItems: [
                  {
                    type: "approval_request",
                    requestId: "ask-1",
                    requestKind: "command",
                    title: "rm -rf build",
                    threadId,
                  },
                  {
                    type: "approval_request",
                    requestId: "allow-1",
                    requestKind: "command",
                    title: "ls",
                    threadId,
                  },
                  {
                    type: "approval_request",
                    requestId: "plain-1",
                    requestKind: "command",
                    title: "ls",
                    threadId,
                  },
                ],
              } as never),
            dispatch: (command) =>
              Deferred.succeed(dispatched, command).pipe(Effect.as({ sequence: 1 } as never)),
          }),
          Layer.mock(TextGeneration.TextGeneration)({
            reviewAction: (input) =>
              Effect.gen(function* () {
                reviewed.push(input.action);
                assert.equal(input.rules, "Never touch production.");
                if (input.action.includes("rm -rf")) {
                  yield* Deferred.succeed(askReviewed, undefined);
                  return { verdict: "ask" as const, reason: "Deletes files." };
                }
                return { verdict: "allow" as const, reason: "Read-only." };
              }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      yield* Queue.offer(events, approval(plainBot, "plain-1", "ls"));
      yield* Queue.offer(events, approval(reviewedBot, "ask-1", "rm -rf build"));
      yield* Deferred.await(askReviewed);
      yield* Queue.offer(events, approval(reviewedBot, "allow-1", "ls"));
      assert.deepInclude(yield* Deferred.await(dispatched), {
        type: "runtime-request.respond",
        requestId: "allow-1",
        decision: "accept",
      });
      // The plain bot's request was never reviewed; the risky one only asked.
      assert.deepEqual(reviewed, ["Kind: command\nrm -rf build", "Kind: command\nls"]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);
