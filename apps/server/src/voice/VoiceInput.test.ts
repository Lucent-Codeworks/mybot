import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { VoiceModelId } from "@mybot/contracts";
import { cliArchiveTarCommand } from "@mybot/shared/cliRelease";
import * as HostProcess from "@mybot/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import * as VoiceInput from "./VoiceInput.ts";
import {
  WHISPER_VERSION,
  type WhisperCliRelease,
  type WhisperModelRelease,
} from "./whisperReleases.ts";

const hostPlatform = HostProcess.Platform.defaultValue();
const CLI_URL = "https://downloads.example/whisper-fixture.tar.gz";
const modelUrl = (model: VoiceModelId) => `https://downloads.example/ggml-${model}.bin`;

/** A real gzipped tarball shaped like whisper.cpp's: one top directory holding whisper-cli. */
const makeCliArchive = Effect.fn("test.makeCliArchive")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "mybot-whisper-fixture-" });
  yield* fs.makeDirectory(path.join(dir, "whisper-fixture"));
  yield* fs.writeFileString(path.join(dir, "whisper-fixture", "whisper-cli"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  const archivePath = path.join(dir, "fixture.tar.gz");
  const result = yield* runner.run({
    command: cliArchiveTarCommand(hostPlatform, HostProcess.Environment.defaultValue()),
    args: ["-czf", archivePath, "-C", dir, "whisper-fixture"],
  });
  expect(result.code).toBe(0);
  return yield* fs.readFile(archivePath);
});

interface HarnessOptions {
  readonly voiceDir?: string;
  readonly cli?: null;
  readonly modelSha256?: string;
  /** Model downloads wait on this before responding. */
  readonly gate?: { readonly model: VoiceModelId; readonly deferred: Deferred.Deferred<void> };
  readonly transcriptionPermit?: Semaphore.Semaphore;
}

const makeHarness = Effect.fn("test.makeVoiceInput")(function* (options: HarnessOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const archive = yield* makeCliArchive();
  const voiceDir =
    options.voiceDir ??
    path.join(yield* fs.makeTempDirectoryScoped({ prefix: "mybot-voice-test-" }), "voice");
  const modelBytes = (model: VoiceModelId) => new TextEncoder().encode(`fixture model ${model}`);
  const sha = (bytes: Uint8Array) =>
    crypto.digest("SHA-256", bytes).pipe(Effect.map((digest) => Hex.encode(digest)));
  const cli: WhisperCliRelease = {
    url: CLI_URL,
    sha256: yield* sha(archive),
    format: "tar.gz",
    root: "whisper-fixture",
    executable: ["whisper-cli"],
    libraryDir: false,
  };
  const modelShas = new Map<VoiceModelId, string>();
  for (const model of ["tiny", "base", "small", "large-v3-turbo"] as const) {
    modelShas.set(model, options.modelSha256 ?? (yield* sha(modelBytes(model))));
  }
  const requests: Array<string> = [];
  const service = yield* VoiceInput.makeVoiceInput({
    voiceDir,
    cli: options.cli === null ? null : cli,
    ...(options.transcriptionPermit ? { transcriptionPermit: options.transcriptionPermit } : {}),
    model: (model): WhisperModelRelease => ({
      model,
      url: modelUrl(model),
      sha256: modelShas.get(model)!,
      sizeBytes: modelBytes(model).byteLength,
      fileName: `ggml-${model}.bin`,
    }),
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request.url);
          if (request.url === CLI_URL) {
            return HttpClientResponse.fromWeb(request, new Response(archive));
          }
          const model = (["tiny", "base", "small", "large-v3-turbo"] as const).find(
            (candidate) => modelUrl(candidate) === request.url,
          )!;
          if (options.gate?.model === model) yield* Deferred.await(options.gate.deferred);
          return HttpClientResponse.fromWeb(request, new Response(modelBytes(model)));
        }),
      ),
    ),
  );
  /** The first status after the running install, if any, settles. */
  const settled = service.changes.pipe(
    Stream.filter((status) => status.phase !== "downloading"),
    Stream.runHead,
    Effect.map(Option.getOrNull),
  );
  const installed = (model: VoiceModelId) =>
    fs.exists(path.join(voiceDir, "models", model, ".mybot-installed"));
  return { service, fs, path, voiceDir, requests, settled, installed };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const installAndSettle = (harness: Harness, model: VoiceModelId) =>
  harness.service.install(model).pipe(Effect.flatMap(() => harness.settled));

describe("VoiceInput", () => {
  it.layer(Layer.provideMerge(ProcessRunner.layer, NodeServices.layer))("install", (it) => {
    it.effect("starts not-installed and downloads nothing", () =>
      Effect.gen(function* () {
        const { service, requests } = yield* makeHarness();
        expect((yield* service.status).phase).toBe("not-installed");
        expect(requests).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("reports an unsupported platform", () =>
      Effect.gen(function* () {
        const { service, requests } = yield* makeHarness({ cli: null });
        expect((yield* service.status).phase).toBe("unsupported");
        const error = yield* service.install("base").pipe(Effect.flip);
        expect(error.reason).toBe("unsupported");
        expect(requests).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("reports progress then ready", () =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<void>();
        const harness = yield* makeHarness({ gate: { model: "base", deferred } });
        const started = yield* harness.service.install("base");
        expect(started).toMatchObject({ phase: "downloading", pendingModel: "base" });
        // Subscribe before the model download may answer, so every update is seen.
        const subscribed = yield* Deferred.make<void>();
        const collected = yield* harness.service.changes.pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.takeUntil((status) => status.phase !== "downloading"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(subscribed);
        yield* Deferred.succeed(deferred, undefined);
        const statuses = yield* Fiber.join(collected);
        expect(
          statuses.some((status) => status.phase === "downloading" && status.downloadedBytes > 0),
        ).toBe(true);
        const final = statuses.at(-1)!;
        expect(final).toMatchObject({ phase: "ready", model: "base", pendingModel: null });
        expect(yield* harness.installed("base")).toBe(true);
        const cliMarker = harness.path.join(
          harness.voiceDir,
          "cli",
          WHISPER_VERSION,
          ".mybot-installed",
        );
        expect(yield* harness.fs.exists(cliMarker)).toBe(true);
      }).pipe(Effect.scoped),
    );

    it.effect("leaves no model when the checksum does not match", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ modelSha256: "0".repeat(64) });
        const final = yield* installAndSettle(harness, "base");
        expect(final?.phase).toBe("failed");
        expect(final?.model).toBeNull();
        expect(final?.message).toContain("corrupted");
        expect(yield* harness.installed("base")).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("ignores unmarked leftovers after a restart", () =>
      Effect.gen(function* () {
        const first = yield* makeHarness();
        const dir = first.path.join(first.voiceDir, "models", "base");
        yield* first.fs.makeDirectory(dir, { recursive: true });
        yield* first.fs.writeFileString(first.path.join(dir, "ggml-base.bin"), "partial");
        const restarted = yield* makeHarness({ voiceDir: first.voiceDir });
        expect((yield* restarted.service.status).phase).toBe("not-installed");
      }).pipe(Effect.scoped),
    );

    it.effect("finds a finished install after a restart", () =>
      Effect.gen(function* () {
        const first = yield* makeHarness();
        yield* installAndSettle(first, "base");
        const restarted = yield* makeHarness({ voiceDir: first.voiceDir });
        expect(yield* restarted.service.status).toMatchObject({ phase: "ready", model: "base" });
      }).pipe(Effect.scoped),
    );

    it.effect("replaces the old model when switching", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        expect((yield* installAndSettle(harness, "base"))?.model).toBe("base");
        const final = yield* installAndSettle(harness, "tiny");
        expect(final).toMatchObject({ phase: "ready", model: "tiny" });
        expect(
          yield* harness.fs.exists(harness.path.join(harness.voiceDir, "models", "base")),
        ).toBe(false);
        expect(yield* harness.installed("tiny")).toBe(true);
        // The CLI was downloaded once.
        expect(harness.requests.filter((url) => url === CLI_URL)).toHaveLength(1);
      }).pipe(Effect.scoped),
    );

    it.effect("keeps the previous model when an install is cancelled", () =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<void>();
        const harness = yield* makeHarness({ gate: { model: "small", deferred } });
        yield* installAndSettle(harness, "base");
        expect((yield* harness.service.install("small")).pendingModel).toBe("small");
        const busy = yield* harness.service.install("tiny").pipe(Effect.flip);
        expect(busy.reason).toBe("busy-install");
        const cancelled = yield* harness.service.cancelInstall;
        expect(cancelled).toMatchObject({ phase: "ready", model: "base", pendingModel: null });
        expect(yield* harness.installed("base")).toBe(true);
        expect(
          yield* harness.fs.exists(harness.path.join(harness.voiceDir, "models", "small")),
        ).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("keeps the previous model when cancelled while a transcription runs", () =>
      Effect.gen(function* () {
        const permit = yield* Semaphore.make(1);
        // Signals when the install asks for the permit, after the new model is placed.
        const hooks = { reached: yield* Deferred.make<void>() };
        const watched: Semaphore.Semaphore = Object.assign(Object.create(permit), {
          withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Deferred.succeed(hooks.reached, undefined).pipe(
              Effect.andThen(permit.withPermit(effect)),
            ),
        });
        const harness = yield* makeHarness({ transcriptionPermit: watched });
        yield* installAndSettle(harness, "base");
        hooks.reached = yield* Deferred.make<void>();
        yield* permit.take(1);
        yield* harness.service.install("small");
        yield* Deferred.await(hooks.reached);
        expect(yield* harness.installed("small")).toBe(true);
        const cancelled = yield* harness.service.cancelInstall;
        yield* permit.release(1);
        expect(cancelled).toMatchObject({ phase: "ready", model: "base", pendingModel: null });
        expect(yield* harness.installed("base")).toBe(true);
        expect(
          yield* harness.fs.exists(harness.path.join(harness.voiceDir, "models", "small")),
        ).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("keeps one model when a restart finds two", () =>
      Effect.gen(function* () {
        const first = yield* makeHarness();
        for (const [model, at] of [
          ["small", 2_000],
          ["base", 1_000],
        ] as const) {
          const dir = first.path.join(first.voiceDir, "models", model);
          yield* first.fs.makeDirectory(dir, { recursive: true });
          const marker = first.path.join(dir, ".mybot-installed");
          yield* first.fs.writeFileString(marker, "fixture\n");
          yield* first.fs.utimes(marker, at, at);
        }
        const restarted = yield* makeHarness({ voiceDir: first.voiceDir });
        // The one verified last wins.
        expect((yield* restarted.service.status).model).toBe("small");
        expect(yield* first.fs.readDirectory(first.path.join(first.voiceDir, "models"))).toEqual([
          "small",
        ]);
      }).pipe(Effect.scoped),
    );

    it.effect("removes the model", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* installAndSettle(harness, "base");
        const removed = yield* harness.service.remove;
        expect(removed).toMatchObject({ phase: "not-installed", model: null });
        expect(yield* harness.fs.exists(harness.path.join(harness.voiceDir, "models"))).toBe(false);
        expect(yield* harness.fs.exists(harness.path.join(harness.voiceDir, "cli"))).toBe(false);
      }).pipe(Effect.scoped),
    );
  });
});
