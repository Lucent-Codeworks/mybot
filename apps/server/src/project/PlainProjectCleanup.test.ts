import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@mybot/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as IdAllocator from "@mybot/provider-core/server/IdAllocator";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as PlainProjectCleanup from "./PlainProjectCleanup.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";

const layerEventPersistence = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
);
const layerServices = Layer.mergeAll(
  LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(layerEventPersistence)),
  ProjectStore.layer,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
  Layer.succeed(WorkspacePaths.WorkspacePaths, {
    normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
      Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
  }),
).pipe(
  Layer.provideMerge(
    ProjectEnrichmentService.layer.pipe(
      Layer.provide(
        Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
          resolvePath: () => Effect.succeed(null),
        }),
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "plain-project-cleanup-" })),
  Layer.provideMerge(NodeServices.layer),
);

function threadCreated(projectId: ProjectId, threadId: ThreadId) {
  const createdAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const payload: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    id: EventId.make(`created:${threadId}`),
    type: "thread.created" as const,
    threadId,
    providerInstanceId,
    occurredAt: createdAt,
    payload,
  };
}

it.effect("deletes plain projects and their threads, keeps bots and every folder", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectService.make;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "plain-project-cleanup-" });

    const create = Effect.fn("create")(function* (
      name: string,
      bot?: { role: string; instructions: string },
    ) {
      const projectId = ProjectId.make(`project:${name}`);
      const threadId = ThreadId.make(`thread:${name}`);
      const workspaceRoot = path.join(root, name);
      yield* fileSystem.makeDirectory(workspaceRoot);
      yield* fileSystem.writeFileString(path.join(workspaceRoot, "notes.md"), name);
      yield* projects.create({
        commandId: CommandId.make(`command:create:${name}`),
        projectId,
        title: name,
        workspaceRoot,
        ...(bot === undefined ? {} : { bot }),
      });
      yield* eventSink.write({ events: [threadCreated(projectId, threadId)] });
      return { projectId, threadId, workspaceRoot };
    });
    const plain = yield* create("plain");
    const scratch = yield* create("scratch");
    const bot = yield* create("bot", { role: "", instructions: "" });

    const removePlainProjects = PlainProjectCleanup.removePlainProjects().pipe(
      Effect.provideService(ProjectService.ProjectService, projects),
    );
    assert.equal(yield* removePlainProjects, 2);

    for (const removed of [plain, scratch]) {
      assert.isTrue(Option.isNone(yield* projects.getById(removed.projectId)));
      assert.isNotNull((yield* projections.getThreadProjection(removed.threadId)).thread.deletedAt);
      // Deleting a project only touches MyBot's database, never the user's files.
      assert.isTrue(yield* fileSystem.exists(path.join(removed.workspaceRoot, "notes.md")));
    }
    assert.isTrue(Option.isSome(yield* projects.getById(bot.projectId)));
    assert.isNull((yield* projections.getThreadProjection(bot.threadId)).thread.deletedAt);

    // The invariant holds after one run, so the next start has nothing to do.
    assert.equal(yield* removePlainProjects, 0);
    assert.deepEqual(
      (yield* projects.listShells()).map((shell) => shell.id),
      [bot.projectId],
    );
  }).pipe(Effect.scoped, Effect.provide(layerServices)),
);
