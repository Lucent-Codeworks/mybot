import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

import * as ProjectEnrichment from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";

const waitForAvailable = Effect.fn("ProjectEnrichmentServiceTest.waitForAvailable")(function* (
  service: ProjectEnrichment.ProjectEnrichmentService["Service"],
  workspaceRoot: string,
  predicate: (value: ProjectEnrichment.ProjectEnrichment) => boolean,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const available = yield* service.peek(workspaceRoot);
    if (predicate(available)) return available;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(`Project metadata for ${workspaceRoot} was not resolved in time.`);
});

const layer = (
  faviconResolver: ProjectFaviconResolver.ProjectFaviconResolver["Service"],
  options: ProjectEnrichment.ProjectEnrichmentServiceOptions = {},
) =>
  Layer.effect(ProjectEnrichment.ProjectEnrichmentService, ProjectEnrichment.make(options)).pipe(
    Layer.provide(Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, faviconResolver)),
  );

it.effect("does not warn about favicons for workspace roots that no longer exist", () =>
  Effect.gen(function* () {
    const warnings: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      warnings.push(message);
    });

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      yield* service.request("/missing");
      yield* service.request("/broken");

      for (let attempt = 0; attempt < 100 && warnings.length === 0; attempt += 1) {
        yield* Effect.yieldNow;
      }

      assert.lengthOf(warnings, 1);
      assert.nestedPropertyVal(warnings[0], "[1].workspaceRoot", "/broken");
    }).pipe(
      Effect.provide(
        layer(
          {
            resolvePath: (workspaceRoot) =>
              Effect.fail(
                workspaceRoot === "/missing"
                  ? new ProjectFaviconResolver.ProjectFaviconResolutionError({
                      operation: "normalize-workspace",
                      workspaceRoot,
                      cause: new WorkspacePaths.WorkspaceRootNotExistsError({
                        workspaceRoot,
                        normalizedWorkspaceRoot: workspaceRoot,
                      }),
                    })
                  : new ProjectFaviconResolver.ProjectFaviconResolutionError({
                      operation: "stat-candidate",
                      workspaceRoot,
                      cause: "favicon resolver failed",
                    }),
              ),
          },
          { concurrency: 1 },
        ).pipe(Layer.provide(Logger.layer([logger], { mergeWithExisting: false }))),
      ),
    );
  }),
);

it.effect("getAvailable returns immediately while the favicon is still unresolved", () =>
  Effect.gen(function* () {
    const faviconStarted = yield* Deferred.make<void>();
    const releaseFavicon = yield* Deferred.make<void>();

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;

      // The non-blocking path must not wait on a slow favicon scan.
      const immediate = yield* service.getAvailable("/pending-favicon");
      assert.isNull(immediate.faviconPath);

      yield* Deferred.await(faviconStarted);

      // The background lane still resolves after the snapshot path has returned.
      yield* Deferred.succeed(releaseFavicon, undefined);
      const resolved = yield* waitForAvailable(
        service,
        "/pending-favicon",
        (value) => value.faviconPath !== null,
      );
      assert.equal(resolved.faviconPath, "/pending-favicon/favicon.svg");
    }).pipe(
      Effect.provide(
        layer({
          resolvePath: (workspaceRoot) =>
            Deferred.succeed(faviconStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFavicon)),
              Effect.as(`${workspaceRoot}/favicon.svg`),
            ),
        }),
      ),
    );
  }),
);

it.effect("deduplicates requests, bounds pending work, and reloads invalidated roots", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const faviconCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const version = yield* Ref.make(1);

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      yield* Effect.forEach(Array.from({ length: 20 }), () => service.request("/first"), {
        concurrency: "unbounded",
        discard: true,
      });
      yield* Deferred.await(firstStarted);
      yield* service.request("/second");
      yield* service.request("/dropped");
      assert.deepEqual(yield* Ref.get(faviconCalls), ["/first"]);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* waitForAvailable(service, "/second", (value) => value.faviconPath !== null);
      assert.deepEqual(yield* Ref.get(faviconCalls), ["/first", "/second"]);

      yield* service.request("/dropped");
      yield* waitForAvailable(service, "/dropped", (value) => value.faviconPath !== null);
      assert.deepEqual(yield* Ref.get(faviconCalls), ["/first", "/second", "/dropped"]);

      yield* Ref.set(version, 2);
      yield* service.invalidate(["/first"]);
      const invalidated = yield* service.getAvailable("/first");
      assert.isNull(invalidated.faviconPath);
      const refreshed = yield* waitForAvailable(
        service,
        "/first",
        (value) => value.faviconPath === "/first/favicon-v2.svg",
      );
      assert.equal(refreshed.faviconPath, "/first/favicon-v2.svg");
      assert.deepEqual(yield* Ref.get(faviconCalls), ["/first", "/second", "/dropped", "/first"]);
    }).pipe(
      Effect.provide(
        layer(
          {
            resolvePath: (workspaceRoot) =>
              Effect.gen(function* () {
                yield* Ref.update(faviconCalls, (calls) => [...calls, workspaceRoot]);
                if (workspaceRoot === "/first" && (yield* Ref.get(version)) === 1) {
                  yield* Deferred.succeed(firstStarted, undefined);
                  yield* Deferred.await(releaseFirst);
                }
                return `${workspaceRoot}/favicon-v${yield* Ref.get(version)}.svg`;
              }),
          },
          { cacheCapacity: 8, maxPending: 2, concurrency: 1 },
        ),
      ),
    );
  }),
);

it.effect("rescans a favicon only after 15 minutes", () =>
  Effect.gen(function* () {
    const faviconScans = yield* Ref.make(0);

    yield* Effect.gen(function* () {
      const service = yield* ProjectEnrichment.ProjectEnrichmentService;
      yield* service.getAvailable("/repo");
      yield* waitForAvailable(
        service,
        "/repo",
        (value) => value.faviconPath === "/repo/favicon-1.svg",
      );

      // Callers such as the shell stream read projects far more often than this.
      for (let minute = 1; minute < 15; minute += 1) {
        yield* TestClock.adjust("1 minute");
        yield* service.getAvailable("/repo");
      }
      assert.equal(yield* Ref.get(faviconScans), 1);

      yield* TestClock.adjust("1 minute");
      yield* service.getAvailable("/repo");
      yield* waitForAvailable(
        service,
        "/repo",
        (value) => value.faviconPath === "/repo/favicon-2.svg",
      );
      assert.equal(yield* Ref.get(faviconScans), 2);
    }).pipe(
      Effect.provide(
        layer({
          // Each scan returns a new path, so a wait can tell a rescan from the cached value.
          resolvePath: (workspaceRoot) =>
            Ref.updateAndGet(faviconScans, (count) => count + 1).pipe(
              Effect.map((scan) => `${workspaceRoot}/favicon-${scan}.svg`),
            ),
        }),
      ),
    );
  }),
);
