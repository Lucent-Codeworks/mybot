/**
 * Creates pets with AI. A hatch is a normal Codex thread in the chosen bot:
 * Codex draws one strip per animation state into a job folder, and when the
 * thread's turn ends the server assembles the strips into an atlas and imports
 * it. `<petsDir>/.hatch/<jobId>/job.json` is the job's source of truth, so a
 * restart mid-hatch picks the job up again.
 */
import {
  type ChatAttachment,
  CommandId,
  DEFAULT_MODEL,
  MessageId,
  type OrchestrationV2Run,
  PetError,
  PetHatchJob,
  type PetHatchInput,
  type PetId,
  type PetRowName,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProjectId,
  ThreadId,
} from "@mybot/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { AtlasError, assembleAtlasFromStrips } from "./atlas.ts";
import { buildHatchPrompt, HATCH_STRIP_ROWS } from "./hatchRecipe.ts";
import * as PetLibrary from "./PetLibrary.ts";

const HATCH_FOLDER = ".hatch";
const JOB_FILE = "job.json";
const MAX_FOLLOW_UPS = 2;
/** How long listing jobs waits for finished hatches to settle before answering. */
const LIST_SETTLE_TIMEOUT = "5 seconds";
const CODEX_UNAVAILABLE_MESSAGE = "Creating a pet with AI needs Codex signed in with ChatGPT.";
const REFERENCE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const PetHatchJobJson = Schema.fromJsonString(PetHatchJob);
const decodeJob = Schema.decodeUnknownOption(PetHatchJobJson);
const encodeJob = Schema.encodeSync(PetHatchJobJson);

/** The atlas bytes, or the reason the strips can't become one. Other failures are defects. */
function assembleOrExplain(strips: ReadonlyMap<PetRowName, Uint8Array>) {
  try {
    return { ok: true, bytes: assembleAtlasFromStrips(strips) } as const;
  } catch (cause) {
    if (cause instanceof AtlasError) return { ok: false, reason: cause.message } as const;
    throw cause;
  }
}

export class PetHatchService extends Context.Service<
  PetHatchService,
  {
    /** Launches a hatching thread on a Codex instance signed in with ChatGPT. */
    readonly start: (input: PetHatchInput) => Effect.Effect<PetHatchJob, PetError>;
    /**
     * Every recorded job, newest first. Jobs whose thread already finished are
     * settled first, so a client that refreshes on the run's end sees the outcome.
     */
    readonly jobs: () => Effect.Effect<ReadonlyArray<PetHatchJob>>;
  }
>()("mybot/pets/PetHatchService") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const library = yield* PetLibrary.PetLibrary;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const projects = yield* ProjectService.ProjectService;
  const scope = yield* Effect.scope;
  // One job is settled at a time, so an event and the sweep never import the same pet twice.
  const settling = yield* Semaphore.make(1);
  // Threads of jobs still hatching, so run events from other threads cost nothing.
  // The minute sweep reads job.json directly and stays the safety net.
  const hatchingThreads = new Map<ThreadId, string>();

  const hatchDir = path.join(config.petsDir, HATCH_FOLDER);
  const jobDir = (jobId: string) => path.join(hatchDir, jobId);
  const stripsDir = (jobId: string) => path.join(jobDir(jobId), "strips");
  const fail = (code: PetError["code"], message: string) => new PetError({ code, message });

  const writeJob = (job: PetHatchJob) => {
    const target = path.join(jobDir(job.jobId), JOB_FILE);
    const temp = `${target}.tmp`;
    return fileSystem.writeFileString(temp, encodeJob(job)).pipe(
      Effect.andThen(fileSystem.rename(temp, target)),
      Effect.mapError(() => fail("io", "Couldn't save the hatching job.")),
      Effect.tap(() =>
        Effect.sync(() => {
          if (job.status === "hatching") hatchingThreads.set(job.threadId, job.jobId);
          else hatchingThreads.delete(job.threadId);
        }),
      ),
    );
  };

  const readJob = (jobId: string) =>
    fileSystem.readFileString(path.join(jobDir(jobId), JOB_FILE)).pipe(
      Effect.map(decodeJob),
      Effect.orElseSucceed(() => Option.none<PetHatchJob>()),
    );

  const readJobs = fileSystem.readDirectory(hatchDir).pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
    Effect.flatMap((names) => Effect.forEach(names, readJob)),
    Effect.map((found) =>
      found
        .flatMap((job) => (Option.isSome(job) ? [job.value] : []))
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
    ),
  );

  /** The first enabled Codex instance signed in with ChatGPT, with its default model. */
  const pickCodex = Effect.fn("PetHatchService.pickCodex")(function* (projectId: ProjectId) {
    for (const provider of yield* providers.getProviders) {
      if (
        provider.driver !== "codex" ||
        !provider.enabled ||
        provider.auth.status !== "authenticated" ||
        provider.auth.type !== "chatgpt"
      ) {
        continue;
      }
      const enabledHere = yield* threads.isProviderInstanceEnabledForProject({
        projectId,
        instanceId: provider.instanceId,
      });
      if (!enabledHere) continue;
      const model =
        provider.models.find((candidate) => candidate.isDefault)?.slug ??
        provider.models[0]?.slug ??
        DEFAULT_MODEL;
      return { instanceId: provider.instanceId, model };
    }
    return yield* fail("codex_unavailable", CODEX_UNAVAILABLE_MESSAGE);
  });

  /** The uploaded reference image, as an attachment on the hatch's first message. */
  const referenceAttachment = Effect.fn("PetHatchService.referenceAttachment")(function* (
    attachmentId: NonNullable<PetHatchInput["referenceAttachmentId"]>,
  ) {
    const missing = fail("not_found", "That reference image could not be found. Try again.");
    const file = resolveAttachmentPathById({ attachmentsDir: config.attachmentsDir, attachmentId });
    if (file === null) return yield* missing;
    const extension = path.extname(file).toLowerCase();
    const mimeType = REFERENCE_MIME_BY_EXTENSION[extension];
    if (mimeType === undefined) {
      return yield* fail("invalid_image", "The reference must be a PNG, JPEG, WebP, or GIF image.");
    }
    const info = yield* fileSystem.stat(file).pipe(Effect.mapError(() => missing));
    const sizeBytes = Number(info.size);
    if (sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      return yield* fail("invalid_image", "The reference image is larger than 10 MB.");
    }
    return {
      type: "image",
      id: attachmentId,
      name: `reference${extension}`,
      mimeType,
      sizeBytes,
    } satisfies ChatAttachment;
  });

  const start: PetHatchService["Service"]["start"] = Effect.fn("PetHatchService.start")(
    function* (input) {
      const codex = yield* pickCodex(input.projectId);
      const attachments =
        input.referenceAttachmentId === undefined
          ? []
          : [yield* referenceAttachment(input.referenceAttachmentId)];
      const jobId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() => fail("io", "Couldn't start hatching.")),
      );
      const job: PetHatchJob = {
        jobId,
        projectId: input.projectId,
        threadId: ThreadId.make(`pet-hatch-${jobId}`),
        displayName: input.displayName,
        description: input.description,
        status: "hatching",
        followUps: 0,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* fileSystem
        .makeDirectory(stripsDir(jobId), { recursive: true })
        .pipe(Effect.mapError(() => fail("io", "Couldn't save the hatching job.")));
      yield* writeJob(job);
      // Launched through intake, which claims the pending reference upload into
      // the thread's store; left pending, the upload sweep deletes it after a day.
      yield* ThreadMessageIntake.launchThread({
        commandId: CommandId.make(`pet-hatch:${jobId}`),
        threadId: job.threadId,
        projectId: input.projectId,
        title: `Hatching ${input.displayName}`,
        modelSelection: codex,
        runtimeMode: "full-access",
        interactionMode: "default",
        initialMessage: {
          messageId: MessageId.make(`pet-hatch:${jobId}`),
          text: buildHatchPrompt({
            displayName: input.displayName,
            description: input.description,
            jobDir: jobDir(jobId),
            hasReference: attachments.length > 0,
          }),
          attachments,
        },
        createdBy: "system",
        creationSource: "server",
      }).pipe(
        Effect.provideService(ThreadLaunchService.ThreadLaunchService, launcher),
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.tapError((cause) =>
          Effect.logWarning("A pet hatching thread failed to launch.", { cause, jobId }).pipe(
            Effect.andThen(Effect.sync(() => hatchingThreads.delete(job.threadId))),
            Effect.andThen(fileSystem.remove(jobDir(jobId), { recursive: true })),
            Effect.ignore,
          ),
        ),
        Effect.mapError((error) =>
          error._tag === "AttachmentClaimError"
            ? fail("invalid_image", error.message)
            : fail("io", "Couldn't start the hatching thread."),
        ),
      );
      return job;
    },
  );

  /** Builds the atlas from the saved strips, or says what Codex has to fix. */
  const assemble = Effect.fn("PetHatchService.assemble")(function* (job: PetHatchJob) {
    const strips = new Map<PetRowName, Uint8Array>();
    const missing: Array<string> = [];
    for (const { name } of HATCH_STRIP_ROWS) {
      const file = path.join(stripsDir(job.jobId), `${name}.png`);
      const bytes = yield* Effect.option(fileSystem.readFile(file));
      if (Option.isSome(bytes)) strips.set(name, bytes.value);
      else missing.push(file);
    }
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing`,
      } as const;
    }
    return yield* Effect.sync(() => assembleOrExplain(strips));
  });

  const finish = (job: PetHatchJob, status: "failed" | "cancelled", error: string) =>
    writeJob({ ...job, status, error });

  const askForFix = Effect.fn("PetHatchService.askForFix")(function* (
    job: PetHatchJob,
    reason: string,
  ) {
    if (job.followUps >= MAX_FOLLOW_UPS) return yield* finish(job, "failed", reason);
    const key = `pet-hatch:${job.jobId}:fix-${job.followUps + 1}`;
    const gone = yield* threads
      .sendToThread({
        projectId: job.projectId,
        commandId: CommandId.make(key),
        threadId: job.threadId,
        messageId: MessageId.make(key),
        text: `MyBot couldn't finish the pet: ${reason}. Please fix it and save the files again.`,
        attachments: [],
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.as(null),
        Effect.catchTags({
          ThreadManagementThreadArchivedError: () =>
            Effect.succeed("The hatching thread was archived."),
          ThreadManagementThreadNotFoundError: () =>
            Effect.succeed("The hatching thread no longer exists."),
        }),
        Effect.mapError(() => fail("io", "Couldn't ask Codex to fix the pet.")),
      );
    if (gone !== null) return yield* finish(job, "cancelled", gone);
    yield* writeJob({ ...job, followUps: job.followUps + 1 });
  });

  /** Gives the hatched pet to the bot it was made in. The job stays done either way. */
  const assignToBot = (job: PetHatchJob, petId: PetId) =>
    Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* projects.getById(job.projectId));
      if (!project?.bot) {
        return yield* Effect.logInfo("A hatched pet's bot is gone, so it was not assigned.", {
          jobId: job.jobId,
        });
      }
      // A bot is replaced whole on update, so carry every other field over.
      yield* projects.update({
        projectId: job.projectId,
        bot: { ...project.bot, petId },
        commandId: CommandId.make(`pet-hatch:${job.jobId}:assign`),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A hatched pet could not be assigned to its bot.", {
          cause,
          jobId: job.jobId,
        }),
      ),
    );

  const completed = Effect.fn("PetHatchService.completed")(function* (job: PetHatchJob) {
    const result = yield* assemble(job);
    if (!result.ok) return yield* askForFix(job, result.reason);
    const pet = yield* library.importAtlasBytes({
      bytes: result.bytes,
      displayName: job.displayName,
      description: job.description,
      source: "hatched",
    });
    yield* writeJob({ ...job, status: "done", petId: pet.id });
    yield* fileSystem.remove(stripsDir(job.jobId), { recursive: true }).pipe(Effect.ignore);
    yield* assignToBot(job, pet.id);
  });

  const runError = (threadId: ThreadId, run: OrchestrationV2Run) =>
    threads
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemRunId: run.id,
        turnItemTypes: ["error"],
      })
      .pipe(
        Effect.map((records) => {
          const item = records.turnItems.findLast((candidate) => candidate.type === "error");
          return item?.type === "error" ? item.failure.message : undefined;
        }),
        Effect.orElseSucceed(() => undefined),
        Effect.map((message) => message ?? "The hatching thread stopped with an error."),
      );

  /** Moves a hatching job on once its thread's latest run has ended. */
  const settle = (jobId: string) =>
    settling.withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* readJob(jobId);
        if (Option.isNone(stored) || stored.value.status !== "hatching") return;
        const job = stored.value;
        if ((yield* threads.getThreadShell(job.threadId)) === null) {
          return yield* finish(job, "cancelled", "The hatching thread no longer exists.");
        }
        const records = yield* threads.getThreadRecords(job.threadId, ["runs"]);
        if (records.thread.deletedAt !== null) {
          return yield* finish(job, "cancelled", "The hatching thread was deleted.");
        }
        const latest = records.runs.reduce<OrchestrationV2Run | undefined>(
          (best, run) => (best === undefined || run.ordinal > best.ordinal ? run : best),
          undefined,
        );
        switch (latest?.status) {
          case "completed":
            return yield* completed(job);
          case "failed":
            return yield* finish(job, "failed", yield* runError(job.threadId, latest));
          case "interrupted":
          case "cancelled":
          case "rolled_back":
            return yield* finish(job, "cancelled", "The hatching thread was stopped.");
          default:
            return;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("A pet hatching job could not be checked.", { cause, jobId }),
        ),
      ),
    );

  const settleAll = readJobs.pipe(
    Effect.flatMap((jobs) =>
      Effect.forEach(
        jobs.filter((job) => job.status === "hatching"),
        (job) => settle(job.jobId),
        { discard: true },
      ),
    ),
  );

  for (const job of yield* readJobs) {
    if (job.status === "hatching") hatchingThreads.set(job.threadId, job.jobId);
  }

  // The event stream starts after the latest event, so the startup check and
  // the minute sweep cover turns that ended while the server was down.
  yield* settleAll.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);

  yield* orchestrator.streamDomainEvents.pipe(
    Stream.runForEach((event) => {
      if (
        event.type !== "run.updated" ||
        !["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
          event.payload.status,
        )
      ) {
        return Effect.void;
      }
      const jobId = hatchingThreads.get(event.payload.threadId);
      return jobId === undefined ? Effect.void : settle(jobId);
    }),
    Effect.tapCause((cause) => Effect.logWarning("Pet hatching events paused.", { cause })),
    Effect.retry(Schedule.spaced("5 seconds")),
    Effect.forkScoped,
  );

  // job.json is replaced by rename, so a read never sees a half-written job.
  // The settle runs in the service's scope, so a timeout stops the wait, not
  // an import halfway through; a hung settle cannot hang the list.
  const jobs: PetHatchService["Service"]["jobs"] = () =>
    readJobs.pipe(
      Effect.flatMap((current) =>
        current.some((job) => job.status === "hatching")
          ? settleAll.pipe(
              Effect.forkIn(scope),
              Effect.flatMap((fiber) =>
                Fiber.await(fiber).pipe(Effect.timeout(LIST_SETTLE_TIMEOUT), Effect.ignore),
              ),
              Effect.andThen(readJobs),
            )
          : Effect.succeed(current),
      ),
    );

  return PetHatchService.of({ start, jobs });
});

export const layer = Layer.effect(PetHatchService, make);
