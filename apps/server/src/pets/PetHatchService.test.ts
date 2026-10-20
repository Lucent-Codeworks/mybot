// @effect-diagnostics nodeBuiltinImport:off -- Fixtures (strips, a stored job) are laid out synchronously around the service.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ChatAttachmentId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RunStatus,
  type PetError,
  type PetHatchJob,
  ProjectId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@mybot/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { HATCH_STRIP_ROWS } from "./hatchRecipe.ts";
import * as PetHatchService from "./PetHatchService.ts";
import * as PetLibrary from "./PetLibrary.ts";
import { encodePng } from "./png.ts";

const projectId = ProjectId.make("project-pets");

const chatgptCodex = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  auth: { status: "authenticated", type: "chatgpt" },
  models: [
    { slug: "gpt-other", isCustom: false },
    { slug: "gpt-default", isCustom: false, isDefault: true },
  ],
} as unknown as ServerProvider;

/** A green strip with `frames` red squares spaced apart, as Codex would draw it. */
const strip = (frames: number) => {
  const size = 20;
  const gap = 20;
  const width = frames * size + (frames + 1) * gap;
  const height = 40;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inFrame = y >= 10 && y < 30 && (x - gap) % (size + gap) < size && x >= gap;
      data.set(inFrame ? [255, 0, 0, 255] : [0, 255, 0, 255], (y * width + x) * 4);
    }
  }
  return encodePng({ width, height, channels: 4, data });
};

const writeStrips = (jobDir: string, skip: ReadonlyArray<string> = []) => {
  const dir = NodePath.join(jobDir, "strips");
  NodeFS.mkdirSync(dir, { recursive: true });
  for (const row of HATCH_STRIP_ROWS) {
    if (skip.includes(row.name)) continue;
    NodeFS.writeFileSync(NodePath.join(dir, `${row.name}.png`), strip(row.frameDurationsMs.length));
  }
};

const runUpdated = (threadId: string, status: OrchestrationV2RunStatus) =>
  ({
    type: "run.updated",
    threadId,
    payload: { id: RunId.make(`${threadId}-run`), threadId: ThreadId.make(threadId), status },
  }) as unknown as OrchestrationV2DomainEvent;

interface Harness {
  readonly hatch: PetHatchService.PetHatchService["Service"];
  readonly pets: PetLibrary.PetLibrary["Service"];
  readonly petsDir: string;
  readonly attachmentsDir: string;
  readonly launches: Array<ThreadLaunchService.ThreadLaunchInput>;
  readonly sends: Queue.Queue<ThreadManagementService.ThreadManagementSendInput>;
  readonly events: Queue.Queue<OrchestrationV2DomainEvent>;
  /** The latest run status of each thread, as the projection would report it. */
  readonly runStatus: Map<string, OrchestrationV2RunStatus>;
  /** Each thread whose latest run the service read, in order. */
  readonly lookups: Queue.Queue<string>;
}

const withHatch = <A, E>(
  options: {
    readonly providers?: ReadonlyArray<ServerProvider>;
    readonly runStatus?: ReadonlyArray<readonly [string, OrchestrationV2RunStatus]>;
    /** Lays out files in petsDir before the service starts, as a previous server run would. */
    readonly before?: (petsDir: string) => void;
  },
  run: (harness: Harness) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const sends = yield* Queue.unbounded<ThreadManagementService.ThreadManagementSendInput>();
    const lookups = yield* Queue.unbounded<string>();
    const launches: Array<ThreadLaunchService.ThreadLaunchInput> = [];
    const runStatus = new Map(options.runStatus ?? []);

    const fakes = Layer.mergeAll(
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) =>
          Effect.sync(() => {
            launches.push(input);
            runStatus.set(input.threadId!, "running");
            return { threadId: input.threadId } as ThreadLaunchService.ThreadLaunchResult;
          }),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        isProviderInstanceEnabledForProject: () => Effect.succeed(true),
        sendToThread: (input) =>
          Queue.offer(sends, input).pipe(
            Effect.andThen(Effect.sync(() => runStatus.set(input.threadId, "queued"))),
            Effect.as({} as ThreadManagementService.ThreadManagementSendResult),
          ),
        getThreadRecords: (threadId, fields) =>
          Effect.gen(function* () {
            const thread = { id: threadId, projectId, archivedAt: null, deletedAt: null };
            if ((fields as ReadonlyArray<string>).includes("turnItems")) {
              return {
                thread,
                turnItems: [{ type: "error", failure: { message: "Codex hit its usage limit." } }],
              } as never;
            }
            const status = runStatus.get(threadId);
            yield* Queue.offer(lookups, threadId);
            return {
              thread,
              runs:
                status === undefined
                  ? []
                  : [{ id: RunId.make(`${threadId}-run`), threadId, ordinal: 1, status }],
            } as never;
          }),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.fromQueue(events) }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed(options.providers ?? [chatgptCodex]),
      }),
    );
    const base = Layer.mergeAll(
      fakes,
      PetLibrary.layer.pipe(Layer.provideMerge(ServerSettings.layerTest())),
    ).pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pets-hatch-" })));

    return yield* Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      options.before?.(config.petsDir);
      return yield* Effect.gen(function* () {
        const hatch = yield* PetHatchService.PetHatchService;
        const pets = yield* PetLibrary.PetLibrary;
        return yield* run({
          hatch,
          pets,
          petsDir: config.petsDir,
          attachmentsDir: config.attachmentsDir,
          launches,
          sends,
          events,
          runStatus,
          lookups,
        });
      }).pipe(Effect.provide(PetHatchService.layer));
    }).pipe(Effect.provide(base));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const input = { projectId, displayName: "Mochi", description: "A round white cat." };

/** Ends the thread's turn and waits until the service has handled it. */
const finishTurn = (harness: Harness, job: PetHatchJob, status: OrchestrationV2RunStatus) =>
  Effect.gen(function* () {
    harness.runStatus.set(job.threadId, status);
    yield* Queue.offer(harness.events, runUpdated(job.threadId, status));
    expect(yield* Queue.take(harness.lookups)).toBe(job.threadId);
    const jobs = yield* harness.hatch.jobs();
    return jobs.find((candidate) => candidate.jobId === job.jobId)!;
  });

it.effect("needs a Codex instance signed in with ChatGPT", () =>
  withHatch(
    { providers: [{ ...chatgptCodex, auth: { status: "authenticated", type: "apiKey" } }] },
    ({ hatch, launches }) =>
      Effect.gen(function* () {
        const error = (yield* Effect.flip(hatch.start(input))) as PetError;
        expect(error.code).toBe("codex_unavailable");
        expect(error.message).toBe("Creating a pet with AI needs Codex signed in with ChatGPT.");
        expect(launches).toHaveLength(0);
      }),
  ),
);

it.effect("writes the job and launches a full-access Codex thread pointed at the job folder", () =>
  withHatch({}, ({ hatch, launches, petsDir }) =>
    Effect.gen(function* () {
      const job = yield* hatch.start(input);
      const jobDir = NodePath.join(petsDir, ".hatch", job.jobId);
      const stored = JSON.parse(NodeFS.readFileSync(NodePath.join(jobDir, "job.json"), "utf8"));
      expect(stored).toMatchObject({ status: "hatching", threadId: job.threadId, followUps: 0 });
      expect(job.status).toBe("hatching");

      expect(launches).toHaveLength(1);
      const launch = launches[0]!;
      expect(launch).toMatchObject({
        threadId: job.threadId,
        projectId,
        title: "Hatching Mochi",
        runtimeMode: "full-access",
        createdBy: "system",
        creationSource: "server",
        modelSelection: { instanceId: "codex", model: "gpt-default" },
      });
      expect(NodePath.isAbsolute(jobDir)).toBe(true);
      expect(launch.initialMessage?.text).toContain(jobDir);
      expect(launch.initialMessage?.attachments).toEqual([]);
      expect(yield* hatch.jobs()).toEqual([job]);
    }),
  ),
);

it.effect("attaches the reference image to the first message", () =>
  withHatch({}, ({ hatch, launches, attachmentsDir }) =>
    Effect.gen(function* () {
      const bytes = strip(2);
      NodeFS.writeFileSync(NodePath.join(attachmentsDir, "pending-reference.png"), bytes);
      yield* hatch.start({
        ...input,
        referenceAttachmentId: ChatAttachmentId.make("pending-reference"),
      });
      expect(launches[0]?.initialMessage?.attachments).toEqual([
        {
          type: "image",
          id: "pending-reference",
          name: "reference.png",
          mimeType: "image/png",
          sizeBytes: bytes.byteLength,
        },
      ]);
      expect(launches[0]?.initialMessage?.text).toContain("reference image");

      const error = (yield* Effect.flip(
        hatch.start({ ...input, referenceAttachmentId: ChatAttachmentId.make("pending-gone") }),
      )) as PetError;
      expect(error.code).toBe("not_found");
    }),
  ),
);

it.effect("assembles the strips into a pet when the turn completes", () =>
  withHatch({}, (harness) =>
    Effect.gen(function* () {
      const job = yield* harness.hatch.start(input);
      const jobDir = NodePath.join(harness.petsDir, ".hatch", job.jobId);
      writeStrips(jobDir);

      const done = yield* finishTurn(harness, job, "completed");
      expect(done.status).toBe("done");
      const pets = yield* harness.pets.list();
      const pet = pets.find((candidate) => candidate.id === done.petId);
      expect(pet).toMatchObject({ displayName: "Mochi", source: "hatched", atlasVersion: 1 });
      expect(NodeFS.existsSync(NodePath.join(jobDir, "strips"))).toBe(false);
    }),
  ),
);

it.effect("asks Codex to fix missing strips twice, then fails the job", () =>
  withHatch({}, (harness) =>
    Effect.gen(function* () {
      const job = yield* harness.hatch.start(input);
      writeStrips(NodePath.join(harness.petsDir, ".hatch", job.jobId), ["failed"]);

      const first = yield* finishTurn(harness, job, "completed");
      const followUp = yield* Queue.take(harness.sends);
      expect(followUp).toMatchObject({
        threadId: job.threadId,
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      });
      expect(followUp.text).toMatch(/^MyBot couldn't finish the pet: .*failed/);
      expect(followUp.text).toContain("Please fix it and save the files again.");
      expect(first).toMatchObject({ status: "hatching", followUps: 1 });

      const second = yield* finishTurn(harness, job, "completed");
      yield* Queue.take(harness.sends);
      expect(second).toMatchObject({ status: "hatching", followUps: 2 });

      const third = yield* finishTurn(harness, job, "completed");
      expect(third.status).toBe("failed");
      expect(third.error).toContain("failed");
      expect(yield* Queue.size(harness.sends)).toBe(0);
    }),
  ),
);

it.effect("marks a stopped hatch cancelled and a failed turn failed", () =>
  withHatch({}, (harness) =>
    Effect.gen(function* () {
      const stopped = yield* harness.hatch.start(input);
      expect((yield* finishTurn(harness, stopped, "interrupted")).status).toBe("cancelled");

      const broken = yield* harness.hatch.start({ ...input, displayName: "Bolt" });
      const failed = yield* finishTurn(harness, broken, "failed");
      expect(failed).toMatchObject({ status: "failed", error: "Codex hit its usage limit." });
    }),
  ),
);

it.effect("finishes a job whose turn completed while the server was down", () => {
  const threadId = "pet-hatch-restart";
  const stored: PetHatchJob = {
    jobId: "restart",
    projectId,
    threadId: ThreadId.make(threadId),
    displayName: "Pip",
    description: "",
    status: "hatching",
    followUps: 0,
    createdAt: "2026-10-19T00:00:00.000Z",
  };
  return withHatch(
    {
      runStatus: [[threadId, "completed"]],
      before: (petsDir) => {
        const jobDir = NodePath.join(petsDir, ".hatch", stored.jobId);
        writeStrips(jobDir);
        NodeFS.writeFileSync(NodePath.join(jobDir, "job.json"), JSON.stringify(stored));
      },
    },
    ({ hatch, pets }) =>
      Effect.gen(function* () {
        const [job] = yield* hatch.jobs();
        expect(job?.status).toBe("done");
        expect((yield* pets.list()).some((pet) => pet.id === job?.petId)).toBe(true);
      }),
  );
});
