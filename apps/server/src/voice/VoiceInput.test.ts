// @effect-diagnostics nodeBuiltinImport:off - the fake whisper-cli talks to a node:http server.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";

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
import * as Queue from "effect/Queue";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import * as VoiceInput from "./VoiceInput.ts";
import { voiceUploadPath } from "./VoiceUpload.ts";
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

  it.layer(Layer.provideMerge(ProcessRunner.layer, NodeServices.layer))("transcribe", (it) => {
    it.effect("returns cleaned text and deletes the upload", () =>
      Effect.gen(function* () {
        const harness = yield* readyHarness();
        yield* useFixture(harness, "echo");
        const upload = yield* writeUpload(harness, "11111111-1111-4111-8111-111111111111");
        const result = yield* harness.service.transcribe(upload.uploadId);
        expect(result.text).toBe("heard 64 bytes");
        expect(NodeFS.existsSync(upload.file)).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("fails not-installed with MyBot wording before setup", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const upload = yield* writeUpload(harness, "22222222-2222-4222-8222-222222222222");
        const error = yield* harness.service.transcribe(upload.uploadId).pipe(Effect.flip);
        expect(error).toMatchObject({
          reason: "not-installed",
          detail: "Voice input is not set up on this MyBot server.",
        });
        expect(NodeFS.existsSync(upload.file)).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("fails upload-missing for an unknown recording", () =>
      Effect.gen(function* () {
        const harness = yield* readyHarness();
        yield* useFixture(harness, "echo");
        const missing = yield* harness.service
          .transcribe("33333333-3333-4333-8333-333333333333")
          .pipe(Effect.flip);
        expect(missing.reason).toBe("upload-missing");
        const traversal = yield* harness.service.transcribe("../../secrets").pipe(Effect.flip);
        expect(traversal.reason).toBe("upload-missing");
      }).pipe(Effect.scoped),
    );

    it.effect("reports a failed whisper-cli run and deletes the upload", () =>
      Effect.gen(function* () {
        const harness = yield* readyHarness();
        yield* useFixture(harness, "fail");
        const upload = yield* writeUpload(harness, "44444444-4444-4444-8444-444444444444");
        const error = yield* harness.service.transcribe(upload.uploadId).pipe(Effect.flip);
        expect(error).toMatchObject({
          reason: "transcription-failed",
          detail: "Could not transcribe this recording.",
        });
        expect(NodeFS.existsSync(upload.file)).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("runs two transcriptions one after the other", () =>
      Effect.gen(function* () {
        const harness = yield* readyHarness();
        const first = yield* writeUpload(harness, "55555555-5555-4555-8555-555555555555");
        const second = yield* writeUpload(harness, "66666666-6666-4666-8666-666666666666");
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const firstUploadAtSecondStart: Array<boolean> = [];
        const server = yield* fixtureServer((wav) =>
          wav === first.file
            ? Deferred.succeed(firstStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirst)),
              )
            : Effect.sync(() => {
                firstUploadAtSecondStart.push(NodeFS.existsSync(first.file));
              }),
        );
        yield* useFixture(harness, server);
        const firstJob = yield* harness.service.transcribe(first.uploadId).pipe(Effect.forkScoped);
        yield* Deferred.await(firstStarted);
        const secondJob = yield* harness.service
          .transcribe(second.uploadId)
          .pipe(Effect.forkScoped);
        yield* Deferred.succeed(releaseFirst, undefined);
        expect((yield* Fiber.join(firstJob)).text).toBe("heard 64 bytes");
        expect((yield* Fiber.join(secondJob)).text).toBe("heard 64 bytes");
        // The second process started only after the first finished and cleaned up.
        expect(firstUploadAtSecondStart).toEqual([false]);
      }).pipe(Effect.scoped),
    );

    it.effect("cancel kills the process and deletes the upload", () =>
      Effect.gen(function* () {
        const harness = yield* readyHarness();
        const upload = yield* writeUpload(harness, "77777777-7777-4777-8777-777777777777");
        const started = yield* Deferred.make<void>();
        const server = yield* fixtureServer(() =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        );
        yield* useFixture(harness, server);
        const job = yield* harness.service
          .transcribe(upload.uploadId)
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(started);
        yield* harness.service.cancelTranscription(upload.uploadId);
        expect((yield* Fiber.join(job)).reason).toBe("cancelled");
        expect(NodeFS.existsSync(upload.file)).toBe(false);
        const pid = Number(
          NodeFS.readFileSync(
            harness.path.join(harness.voiceDir, "cli", WHISPER_VERSION, "pid"),
            "utf8",
          ),
        );
        // Signal 0 only checks that the process exists.
        expect(() => process.kill(pid, 0)).toThrow();
      }).pipe(Effect.scoped),
    );

    it.effect("remove waits for a running transcription", () =>
      Effect.gen(function* () {
        const harness = yield* readyHarness();
        const upload = yield* writeUpload(harness, "88888888-8888-4888-8888-888888888888");
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const server = yield* fixtureServer(() =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        yield* useFixture(harness, server);
        const job = yield* harness.service.transcribe(upload.uploadId).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const removing = yield* harness.service.remove.pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(removing.pollUnsafe()).toBeUndefined();
        expect(yield* harness.installed("base")).toBe(true);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(job)).text).toBe("heard 64 bytes");
        expect((yield* Fiber.join(removing)).phase).toBe("not-installed");
      }).pipe(Effect.scoped),
    );
  });
});

const readyHarness = Effect.fn("test.readyHarness")(function* () {
  const harness = yield* makeHarness();
  expect((yield* installAndSettle(harness, "base"))?.phase).toBe("ready");
  return harness;
});

/** Writes a 64-byte recording where the upload route would store it. */
const writeUpload = Effect.fn("test.writeUpload")(function* (harness: Harness, uploadId: string) {
  const file = voiceUploadPath(harness.path, harness.voiceDir, uploadId);
  yield* harness.fs.makeDirectory(harness.path.dirname(file), { recursive: true });
  yield* harness.fs.writeFile(file, new Uint8Array(64));
  return { uploadId, file };
});

/**
 * A local server the fake whisper-cli calls with its `-f` path before printing;
 * the process waits until `onStart` completes.
 */
const fixtureServer = Effect.fn("test.fixtureServer")(function* (
  onStart: (wav: string) => Effect.Effect<void>,
) {
  const requests = yield* Queue.unbounded<{
    readonly wav: string;
    readonly response: NodeHttp.ServerResponse;
  }>();
  // Each request is answered once its `onStart` completes; they run concurrently.
  yield* Queue.take(requests).pipe(
    Effect.flatMap(({ wav, response }) =>
      onStart(wav).pipe(Effect.andThen(Effect.sync(() => response.end("ok"))), Effect.forkScoped),
    ),
    Effect.forever,
    Effect.forkScoped,
  );
  const server = yield* Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const created = NodeHttp.createServer((request, response) => {
        const wav = new URL(request.url ?? "/", "http://fixture").searchParams.get("wav") ?? "";
        Queue.offerUnsafe(requests, { wav, response });
      });
      created.listen(0, "127.0.0.1", () => resume(Effect.succeed(created)));
    }),
    (created) =>
      Effect.callback<void>((resume) => {
        created.closeAllConnections();
        created.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no fixture port");
  return `http://127.0.0.1:${address.port}/`;
});

/**
 * Replaces the installed whisper-cli with a Node script. `echo` prints the
 * recording's size between non-speech markers, `fail` exits 1, and a URL makes
 * it call `fixtureServer` first.
 */
const useFixture = Effect.fn("test.useFixture")(function* (harness: Harness, mode: string) {
  const dir = harness.path.join(harness.voiceDir, "cli", WHISPER_VERSION);
  const script = [
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `const args = process.argv.slice(2);`,
    `const wav = args[args.indexOf("-f") + 1];`,
    `const mode = fs.readFileSync(path.join(__dirname, "mode"), "utf8");`,
    `fs.writeFileSync(path.join(__dirname, "pid"), String(process.pid));`,
    `(async () => {`,
    `  if (mode === "fail") { process.stderr.write("fixture failure\\n"); process.exit(1); }`,
    `  if (mode.startsWith("http")) await (await fetch(mode + "?wav=" + encodeURIComponent(wav))).text();`,
    `  process.stdout.write(" [BLANK_AUDIO]\\n heard " + fs.statSync(wav).size + " bytes (silence)\\n");`,
    `})();`,
  ].join("\n");
  yield* harness.fs.writeFileString(harness.path.join(dir, "fixture.cjs"), script);
  // A shell wrapper, because a shebang cannot hold a node path with spaces.
  const node = process.execPath.replaceAll("'", "'\\''");
  yield* harness.fs.writeFileString(
    harness.path.join(dir, "whisper-cli"),
    `#!/bin/sh\nexec '${node}' "$(dirname "$0")/fixture.cjs" "$@"\n`,
  );
  yield* harness.fs.writeFileString(harness.path.join(dir, "mode"), mode);
});
