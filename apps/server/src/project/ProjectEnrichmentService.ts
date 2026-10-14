import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";

const DEFAULT_CACHE_CAPACITY = 512;
const DEFAULT_MAX_PENDING = 512;
const DEFAULT_CONCURRENCY = 4;
// A favicon scan checks about 20 files and icons rarely change, so a resolved
// favicon is kept for a while. Moving a project's workspace root, and deleting
// it, invalidate it.
const DEFAULT_FAVICON_TTL = Duration.minutes(15);
const DEFAULT_FAILURE_TTL = Duration.seconds(5);

export interface ProjectEnrichment {
  readonly faviconPath: string | null;
}

export interface ProjectEnrichmentServiceOptions {
  readonly cacheCapacity?: number;
  /** Maximum active and queued roots. */
  readonly maxPending?: number;
  /** Worker concurrency. */
  readonly concurrency?: number;
  readonly faviconTtl?: Duration.Input;
  readonly failureTtl?: Duration.Input;
}

export class ProjectEnrichmentService extends Context.Service<
  ProjectEnrichmentService,
  {
    /** Read resolved metadata without starting or awaiting filesystem work. */
    readonly peek: (workspaceRoot: string) => Effect.Effect<ProjectEnrichment>;
    /** Schedule missing metadata for bounded background resolution. */
    readonly request: (workspaceRoot: string) => Effect.Effect<void>;
    /** Read immediately available metadata and schedule anything missing. */
    readonly getAvailable: (workspaceRoot: string) => Effect.Effect<ProjectEnrichment>;
    /** Invalidate workspace-derived metadata. */
    readonly invalidate: (workspaceRoots: Iterable<string>) => Effect.Effect<void>;
  }
>()("t3/project/ProjectEnrichmentService") {}

function availableValue<A, E>(cached: Option.Option<Exit.Exit<A, E>>): A | null {
  return Option.match(cached, {
    onNone: () => null,
    onSome: (exit) =>
      Exit.match(exit, {
        onFailure: () => null,
        onSuccess: (value) => value,
      }),
  });
}

export const make = Effect.fn("ProjectEnrichmentService.make")(function* (
  options: ProjectEnrichmentServiceOptions = {},
) {
  const faviconResolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
  const cacheCapacity = Math.max(1, options.cacheCapacity ?? DEFAULT_CACHE_CAPACITY);
  const maxPending = Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const failureTtl = options.failureTtl ?? DEFAULT_FAILURE_TTL;
  const faviconTtl = options.faviconTtl ?? DEFAULT_FAVICON_TTL;

  const faviconCache = yield* Cache.makeWith(
    (workspaceRoot: string) => Effect.exit(faviconResolver.resolvePath(workspaceRoot)),
    {
      capacity: cacheCapacity,
      timeToLive: Exit.match({
        onFailure: () => failureTtl,
        onSuccess: (result) => (Exit.isSuccess(result) ? faviconTtl : failureTtl),
      }),
    },
  );
  const pendingRoots = yield* Ref.make<ReadonlySet<string>>(new Set());
  const queue = yield* Effect.acquireRelease(Queue.dropping<string>(maxPending), (queue) =>
    Queue.shutdown(queue),
  );

  const removePending = (workspaceRoot: string) =>
    Ref.update(pendingRoots, (current) => {
      if (!current.has(workspaceRoot)) return current;
      const next = new Set(current);
      next.delete(workspaceRoot);
      return next;
    });

  const reservePending = (workspaceRoot: string) =>
    Ref.modify(pendingRoots, (current) => {
      if (current.has(workspaceRoot) || current.size >= maxPending) {
        return [false, current] as const;
      }
      const next = new Set(current);
      next.add(workspaceRoot);
      return [true, next] as const;
    });

  const resolveFavicon = Effect.fn("ProjectEnrichmentService.resolveFavicon")(function* (
    workspaceRoot: string,
  ) {
    const faviconPath = yield* Cache.get(faviconCache, workspaceRoot);
    if (
      Exit.isFailure(faviconPath) &&
      !Option.exists(
        Exit.findErrorOption(faviconPath),
        ProjectFaviconResolver.isMissingWorkspaceRoot,
      )
    ) {
      yield* Effect.logWarning("Failed to enrich optional project metadata", {
        workspaceRoot,
        field: "faviconPath",
        cause: Cause.pretty(faviconPath.cause),
      });
    }
  });

  const worker = Queue.take(queue).pipe(
    Effect.flatMap((workspaceRoot) =>
      resolveFavicon(workspaceRoot).pipe(Effect.ensuring(removePending(workspaceRoot))),
    ),
    Effect.forever,
  );
  yield* Effect.forEach(Array.from({ length: concurrency }), () => Effect.forkScoped(worker), {
    discard: true,
  });

  const peek: ProjectEnrichmentService["Service"]["peek"] = Effect.fn(
    "ProjectEnrichmentService.peek",
  )(function* (workspaceRoot) {
    return { faviconPath: availableValue(yield* Cache.getSuccess(faviconCache, workspaceRoot)) };
  });

  const request: ProjectEnrichmentService["Service"]["request"] = Effect.fn(
    "ProjectEnrichmentService.request",
  )(function* (workspaceRoot) {
    if (yield* Cache.has(faviconCache, workspaceRoot)) return;
    if (!(yield* reservePending(workspaceRoot))) return;
    if (!(yield* Queue.offer(queue, workspaceRoot))) {
      yield* removePending(workspaceRoot);
      yield* Effect.logWarning("Project metadata enrichment queue is full", {
        workspaceRoot,
        field: "faviconPath",
      });
    }
  });

  const getAvailable: ProjectEnrichmentService["Service"]["getAvailable"] = Effect.fn(
    "ProjectEnrichmentService.getAvailable",
  )(function* (workspaceRoot) {
    const available = yield* peek(workspaceRoot);
    yield* request(workspaceRoot);
    return available;
  });

  const invalidate: ProjectEnrichmentService["Service"]["invalidate"] = Effect.fn(
    "ProjectEnrichmentService.invalidate",
  )(function* (workspaceRoots) {
    yield* Effect.forEach(
      new Set(workspaceRoots),
      (workspaceRoot) => Cache.invalidate(faviconCache, workspaceRoot),
      { discard: true },
    );
  });

  return ProjectEnrichmentService.of({ peek, request, getAvailable, invalidate });
});

export const layer = Layer.effect(ProjectEnrichmentService, make());
