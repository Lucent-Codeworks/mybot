import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";

const layerEnrichment = ProjectEnrichmentService.layer.pipe(
  Layer.provide(
    Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
      resolvePath: () => Effect.succeed(null),
    }),
  ),
);

interface HarnessOptions {
  /** Wraps the real ProjectService, for failures it cannot produce on demand. */
  readonly projects?: (
    real: ProjectService.ProjectService["Service"],
  ) => ProjectService.ProjectService["Service"];
  /** Wraps the real Crypto the service uses, to hold a create mid-flight. */
  readonly crypto?: (real: Crypto.Crypto) => Crypto.Crypto;
}

/** The service over a real ProjectService, with its data dir at `baseDir`. */
const layer = (baseDir: string, options?: HarnessOptions) =>
  ManagedProjectFolders.layer.pipe(
    Layer.provide(
      options?.crypto === undefined
        ? Layer.empty
        : Layer.effect(Crypto.Crypto, Crypto.Crypto.pipe(Effect.map(options.crypto))),
    ),
    Layer.provide(
      options?.projects === undefined
        ? Layer.empty
        : Layer.effect(
            ProjectService.ProjectService,
            ProjectService.ProjectService.pipe(Effect.map(options.projects)),
          ),
    ),
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(layerEnrichment),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

/** Runs `body` with a data dir in a fresh temp folder. */
const withScratch = <A, E>(
  body: (input: {
    readonly baseDir: string;
  }) => Effect.Effect<
    A,
    E,
    | ManagedProjectFolders.ManagedProjectFolders
    | ProjectService.ProjectService
    | ServerSettings.ServerSettingsService
    | NodeServices.NodeServices
    | Scope.Scope
  >,
  options?: HarnessOptions,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-managed-folders-" });
    return yield* body({ baseDir }).pipe(Effect.provide(layer(baseDir, options)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("offers a Scratch folder under the data dir", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const path = yield* Path.Path;
      assert.equal(scratch.scratchRoot, path.resolve(baseDir, "scratch"));
    }),
  ),
);

it.effect("creates one Scratch project, even for concurrent first requests", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      // Without handling the losing creates' conflicts, eight racers fail.
      const racers = yield* Effect.all(
        Array.from({ length: 8 }, () => scratch.ensureScratchProject),
        { concurrency: "unbounded" },
      );
      const again = yield* scratch.ensureScratchProject;
      assert.deepEqual(
        new Set(racers.map((result) => result.projectId)),
        new Set([again.projectId]),
      );

      const snapshot = yield* projects.snapshot;
      const scratchProjects = snapshot.projects.filter(
        (project) => project.workspaceRoot === scratch.scratchRoot,
      );
      assert.lengthOf(scratchProjects, 1);
      assert.equal(scratchProjects[0]?.title, "No project");
      assert.deepEqual(scratchProjects[0]?.projectIcon, {
        kind: "lucide",
        name: "message-square-dashed",
        color: "gray",
      });
    }),
  ),
);

it.effect("recreates the Scratch folder after it is deleted", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const scratch = yield* ManagedProjectFolders.ManagedProjectFolders;
      const fileSystem = yield* FileSystem.FileSystem;
      const { projectId } = yield* scratch.ensureScratchProject;
      yield* fileSystem.remove(scratch.scratchRoot, { recursive: true });

      assert.equal((yield* scratch.ensureScratchProject).projectId, projectId);
      assert.isTrue(yield* fileSystem.exists(scratch.scratchRoot));
    }),
  ),
);

it.effect("starts a named project with a README and an icon, and suffixes a taken name", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.resolve(baseDir, "projects");
      assert.equal(folders.namedProjectsRoot, root);

      const first = yield* folders.createNamedProject({ name: "Pinball Stats" });
      const second = yield* folders.createNamedProject({ name: "pinball stats" });

      assert.equal(first.workspaceRoot, path.join(root, "pinball-stats"));
      assert.equal(second.workspaceRoot, path.join(root, "pinball-stats-2"));
      const project = Option.getOrThrow(yield* projects.getById(first.projectId));
      assert.equal(project.title, "Pinball Stats");
      assert.equal(project.workspaceRoot, first.workspaceRoot);

      const readme = yield* fileSystem.readFileString(path.join(first.workspaceRoot, "README.md"));
      assert.include(readme, "# Pinball Stats");
      assert.include(readme, `src="assets/icon.svg"`);
      const icon = yield* fileSystem.readFileString(
        path.join(first.workspaceRoot, "assets", "icon.svg"),
      );
      assert.include(icon, ">PS</text>");
      assert.isFalse(yield* fileSystem.exists(path.join(first.workspaceRoot, ".git")));
    }),
  ),
);

it.effect("starts a bot with its profile and chosen model", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const bot = { role: "Daily tech scout", instructions: "Summarize my bookmarks." };
      const defaultModelSelection = {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
      };

      const created = yield* folders.createNamedProject({
        name: "Scout",
        bot,
        defaultModelSelection,
      });

      const project = Option.getOrThrow(yield* projects.getById(created.projectId));
      assert.deepStrictEqual(project.bot, bot);
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      assert.deepStrictEqual(
        resolveProjectSettings(settings, created.projectId, project).settings.defaultModelSelection,
        defaultModelSelection,
      );
    }),
  ),
);

it.effect("gives concurrent named projects with the same name distinct folders", () =>
  withScratch(() =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const created = yield* Effect.all(
        Array.from({ length: 4 }, () => folders.createNamedProject({ name: "Race" })),
        { concurrency: "unbounded" },
      );

      assert.equal(new Set(created.map((result) => result.workspaceRoot)).size, 4);
      assert.equal(new Set(created.map((result) => result.projectId)).size, 4);
      const snapshot = yield* projects.snapshot;
      for (const result of created) {
        assert.isTrue(
          snapshot.projects.some((project) => project.workspaceRoot === result.workspaceRoot),
        );
      }
    }),
  ),
);

it.effect("keeps a folder that another project owns when the create conflicts", () =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
      const projects = yield* ProjectService.ProjectService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const taken = path.join(folders.namedProjectsRoot, "taken");
      // A project registered at this path some other way (by hand, or a
      // client that predates the claim) owns the folder the create claims.
      yield* projects.create({
        commandId: CommandId.make("command:owner"),
        projectId: ProjectId.make("project:owner"),
        title: "Owner",
        workspaceRoot: taken,
        createWorkspaceRootIfMissing: true,
      });
      yield* fileSystem.remove(taken, { recursive: true });

      const failure = yield* Effect.flip(folders.createNamedProject({ name: "Taken" }));

      assert.equal(failure._tag, "NamedProjectCreateError");
      assert.equal(failure.message, "Failed to create the project.");
      assert.isTrue(yield* fileSystem.exists(path.join(taken, "README.md")));
      const owner = yield* projects.getByWorkspaceRoot(taken);
      assert.equal(Option.getOrThrow(owner).id, ProjectId.make("project:owner"));
      assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), [
        "taken",
      ]);
    }),
  ),
);

it.effect("removes the folder when the project create is rejected for another reason", () =>
  withScratch(
    ({ baseDir }) =>
      Effect.gen(function* () {
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const failure = yield* Effect.flip(folders.createNamedProject({ name: "Rejected" }));

        assert.equal(failure._tag, "NamedProjectCreateError");
        assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), []);
      }),
    {
      // The project store failing the create is not something a real
      // ProjectService can be made to do on demand.
      projects: (real) =>
        ProjectService.ProjectService.of({
          ...real,
          create: (input) =>
            Effect.fail(
              new ProjectService.ProjectOperationError({
                operation: "dispatch-project-command",
                projectId: input.projectId,
                cause: "store unavailable",
              }),
            ),
        }),
    },
  ),
);

it.effect("removes the folder when the create is cancelled before the project exists", () =>
  Effect.gen(function* () {
    const scaffolded = yield* Deferred.make<void>();
    yield* withScratch(
      ({ baseDir }) =>
        Effect.gen(function* () {
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const projects = yield* ProjectService.ProjectService;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const fiber = yield* folders
            .createNamedProject({ name: "Cancelled" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(scaffolded);
          assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), [
            "cancelled",
          ]);
          yield* Fiber.interrupt(fiber);

          assert.deepEqual(yield* fileSystem.readDirectory(path.resolve(baseDir, "projects")), []);
          assert.deepEqual((yield* projects.snapshot).projects, []);
        }),
      {
        // Holds the project id, minted after the folder is scaffolded, so the
        // create can be interrupted before the project exists.
        crypto: (real) => ({
          ...real,
          randomUUIDv4: Deferred.succeed(scaffolded, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      },
    );
  }),
);
