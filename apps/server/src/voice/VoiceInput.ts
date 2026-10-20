// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest or CPU count.
import {
  VoiceInputError,
  VoiceModelId,
  type VoiceInputStatus,
  type VoiceTranscribeResult,
} from "@mybot/contracts";
import { cliArchiveTarCommand } from "@mybot/shared/cliRelease";
import * as HostProcess from "@mybot/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as ProcessRunner from "../processRunner.ts";
import { isVoiceUploadId, resolveVoiceDir, voiceUploadPath } from "./VoiceUpload.ts";
import {
  WHISPER_VERSION,
  cleanTranscript,
  pinnedWhisperCli,
  pinnedWhisperModel,
  whisperArgs,
  type WhisperCliRelease,
  type WhisperModelRelease,
} from "./whisperReleases.ts";

/** Written into an install's directory before it is renamed into place. */
const INSTALLED_MARKER = ".mybot-installed";
const CLI_SETUP_TIMEOUT = Duration.minutes(5);
const EXTRACT_TIMEOUT = Duration.minutes(2);
const MODEL_DOWNLOAD_TIMEOUT = Duration.minutes(45);
const TRANSCRIBE_TIMEOUT = Duration.minutes(10);
/** Far above any pinned whisper-cli archive, so a broken mirror cannot fill the disk. */
const MAX_CLI_ARCHIVE_BYTES = 100_000_000;
const MODEL_SIZE_SLACK_BYTES = 1_000_000;
/** Progress is published at most once per 256 KB and once per 250 ms. */
const PROGRESS_BYTES = 256 * 1024;
const PROGRESS_MS = 250;

const MESSAGES: Record<VoiceInputError["reason"], string> = {
  unsupported: "Voice input is not available for this kind of computer yet.",
  "not-installed": "Voice input is not set up on this MyBot server.",
  download:
    "Could not download the speech model to this MyBot server. Check its internet connection and try again.",
  checksum: "The speech model download was corrupted, so it was not used. Try again.",
  unpack:
    "Could not unpack speech recognition on this MyBot server. Check free disk space and try again.",
  save: "Could not save the speech model on this MyBot server. Check free disk space and try again.",
  timeout:
    "The speech model download took too long. Check this MyBot server's internet connection and try again.",
  "upload-missing": "The recording was not found on this MyBot server. Record it again.",
  "transcription-failed": "Could not transcribe this recording.",
  cancelled: "Transcription was cancelled.",
  "busy-install": "The speech model is already being downloaded.",
};

const voiceError = (reason: VoiceInputError["reason"]) =>
  new VoiceInputError({ reason, detail: MESSAGES[reason] });
const isVoiceInputError = Schema.is(VoiceInputError);
const isVoiceModelId = Schema.is(VoiceModelId);

/** Passes VoiceInputErrors through; logs anything else and replaces it with `reason`. */
const orVoiceError =
  (reason: VoiceInputError["reason"]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, VoiceInputError, R> =>
    Effect.catch(effect, (cause) =>
      isVoiceInputError(cause)
        ? Effect.fail(cause)
        : Effect.logWarning("Voice input setup step failed.", { reason, cause }).pipe(
            Effect.andThen(Effect.fail(voiceError(reason))),
          ),
    );

export class VoiceInput extends Context.Service<
  VoiceInput,
  {
    readonly status: Effect.Effect<VoiceInputStatus>;
    /** The current status first, then every update. */
    readonly changes: Stream.Stream<VoiceInputStatus>;
    /** Starts downloading whisper-cli (if needed) and `model`; returns once started. */
    readonly install: (model: VoiceModelId) => Effect.Effect<VoiceInputStatus, VoiceInputError>;
    /** Stops a running download. The previously installed model stays. */
    readonly cancelInstall: Effect.Effect<VoiceInputStatus>;
    /** Deletes whisper-cli and the model once running transcriptions finish. */
    readonly remove: Effect.Effect<VoiceInputStatus, VoiceInputError>;
    /**
     * Transcribes an uploaded recording, one at a time in arrival order, and
     * deletes it. Fails `cancelled` when `cancelTranscription` stops it.
     */
    readonly transcribe: (
      uploadId: string,
    ) => Effect.Effect<VoiceTranscribeResult, VoiceInputError>;
    /** Stops a queued or running transcription and deletes its recording. */
    readonly cancelTranscription: (uploadId: string) => Effect.Effect<void>;
  }
>()("mybot/voice/VoiceInput") {}

export interface VoiceInputOptions {
  /** `<baseDir>/voice`. */
  readonly voiceDir: string;
  /** Defaults to the pinned build for this computer; null means unsupported. */
  readonly cli?: WhisperCliRelease | null;
  /** Defaults to the pinned models. */
  readonly model?: (model: VoiceModelId) => WhisperModelRelease;
  /** Tests pass one in to hold it like a running transcription. */
  readonly transcriptionPermit?: Semaphore.Semaphore;
}

export const makeVoiceInput = Effect.fn("VoiceInput.make")(function* (options: VoiceInputOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const hostEnv = yield* HostProcess.Environment;
  const serviceScope = yield* Effect.scope;
  const cli = options.cli === undefined ? pinnedWhisperCli(platform, arch) : options.cli;
  const modelRelease = options.model ?? pinnedWhisperModel;

  const cliParent = path.join(options.voiceDir, "cli");
  const cliDir = path.join(cliParent, WHISPER_VERSION);
  const modelsDir = path.join(options.voiceDir, "models");
  const modelDir = (model: VoiceModelId) => path.join(modelsDir, model);
  /**
   * Held by each transcription, and by anything that deletes files a
   * transcription reads (remove, replacing the model), so those wait for it.
   */
  const transcriptionPermit = options.transcriptionPermit ?? (yield* Semaphore.make(1));
  // Serializes starting, cancelling, and removing; the download itself runs outside it.
  const gate = yield* Semaphore.make(1);
  let running: Fiber.Fiber<void> | undefined;

  const isComplete = (dir: string) =>
    fs.exists(path.join(dir, INSTALLED_MARKER)).pipe(Effect.orElseSucceed(() => false));

  /**
   * Marked model installs, newest marker first, then by name. More than one
   * means a replacement stopped before it removed the old model.
   */
  const markedModels = Effect.gen(function* () {
    const names = yield* fs.readDirectory(modelsDir).pipe(Effect.orElseSucceed(() => []));
    const marked: Array<{ readonly model: VoiceModelId; readonly at: number }> = [];
    for (const name of names) {
      if (!isVoiceModelId(name)) continue;
      const info = yield* fs.stat(path.join(modelDir(name), INSTALLED_MARKER)).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      marked.push({ model: name, at: Option.getOrUndefined(info.value.mtime)?.getTime() ?? 0 });
    }
    return marked
      .sort((a, b) => b.at - a.at || a.model.localeCompare(b.model))
      .map((entry) => entry.model);
  });

  const removeModel = (model: VoiceModelId) =>
    fs
      .remove(modelDir(model), { recursive: true, force: true })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not remove a speech model.", { model, cause }),
        ),
      );

  /** Status from marked installs on disk; unmarked directories are leftovers. */
  const installedStatus = Effect.gen(function* () {
    const model = (yield* markedModels)[0] ?? null;
    const cliReady = yield* isComplete(cliDir);
    return {
      phase: cli === null ? "unsupported" : model !== null && cliReady ? "ready" : "not-installed",
      model,
      pendingModel: null,
      downloadedBytes: 0,
      totalBytes: null,
      message: null,
    } satisfies VoiceInputStatus;
  });

  // A crash mid-replacement can leave two models; keep the one verified last.
  for (const extra of (yield* markedModels).slice(1)) yield* removeModel(extra);
  const state = yield* SubscriptionRef.make<VoiceInputStatus>(yield* installedStatus);

  /** Streams `url` into `file`, checking its size bound and SHA-256. */
  const download = (input: {
    readonly url: string;
    readonly sha256: string;
    readonly maxBytes: number;
    readonly file: string;
    readonly onProgress: (received: number) => Effect.Effect<void>;
  }) =>
    Effect.gen(function* () {
      const response = yield* http
        .execute(HttpClientRequest.get(input.url))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const hash = NodeCrypto.createHash("sha256");
      let received = 0;
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.suspend(() => {
            received += chunk.byteLength;
            if (received > input.maxBytes) return Effect.fail(voiceError("checksum"));
            hash.update(chunk);
            return input.onProgress(received);
          }),
        ),
        Stream.run(fs.sink(input.file, { flag: "wx" })),
      );
      if (hash.digest("hex") !== input.sha256) return yield* voiceError("checksum");
    }).pipe(orVoiceError("download"));

  /** Removes everything in `parent` except `keep` and staging directories. */
  const removeOthers = (parent: string, keep: string) =>
    Effect.gen(function* () {
      for (const name of yield* fs.readDirectory(parent)) {
        if (name === keep || name.startsWith(".")) continue;
        yield* fs.remove(path.join(parent, name), { recursive: true, force: true });
      }
    });

  const installCli = (release: WhisperCliRelease) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(cliParent, { recursive: true });
      // Staging shares the install's filesystem, so publishing is one rename.
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: cliParent,
        prefix: ".install-",
      });
      const archive = path.join(staging, `download.${release.format}`);
      yield* download({
        url: release.url,
        sha256: release.sha256,
        maxBytes: MAX_CLI_ARCHIVE_BYTES,
        file: archive,
        onProgress: () => Effect.void,
      });
      const unpacked = path.join(staging, "unpacked");
      const root = yield* Effect.gen(function* () {
        yield* fs.makeDirectory(unpacked);
        const result = yield* runner.run({
          command: cliArchiveTarCommand(platform, hostEnv),
          args: [release.format === "zip" ? "-xf" : "-xzf", archive, "-C", unpacked],
          timeout: EXTRACT_TIMEOUT,
        });
        const root = path.join(unpacked, release.root);
        if (result.code !== 0 || !(yield* fs.exists(path.join(root, ...release.executable)))) {
          return yield* voiceError("unpack");
        }
        return root;
      }).pipe(orVoiceError("unpack"));
      yield* fs.writeFileString(path.join(root, INSTALLED_MARKER), `${WHISPER_VERSION}\n`);
      yield* fs.remove(cliDir, { recursive: true, force: true });
      yield* fs.rename(root, cliDir);
      // Builds from earlier pins.
      yield* removeOthers(cliParent, WHISPER_VERSION);
    }).pipe(
      Effect.scoped,
      orVoiceError("save"),
      Effect.timeoutOrElse({
        duration: CLI_SETUP_TIMEOUT,
        orElse: () => Effect.fail(voiceError("timeout")),
      }),
    );

  const installModel = (release: WhisperModelRelease) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(modelsDir, { recursive: true });
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: modelsDir,
        prefix: ".install-",
      });
      const content = path.join(staging, release.model);
      yield* fs.makeDirectory(content);
      let lastBytes = 0;
      let lastAt = yield* Clock.currentTimeMillis;
      yield* download({
        url: release.url,
        sha256: release.sha256,
        maxBytes: release.sizeBytes + MODEL_SIZE_SLACK_BYTES,
        file: path.join(content, release.fileName),
        onProgress: (received) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const due = received - lastBytes >= PROGRESS_BYTES && now - lastAt >= PROGRESS_MS;
            if (!due && received !== release.sizeBytes) return;
            lastBytes = received;
            lastAt = now;
            yield* SubscriptionRef.update(state, (current) => ({
              ...current,
              downloadedBytes: received,
            }));
          }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: MODEL_DOWNLOAD_TIMEOUT,
          orElse: () => Effect.fail(voiceError("timeout")),
        }),
      );
      yield* fs.writeFileString(path.join(content, INSTALLED_MARKER), `${release.sha256}\n`);
      // A directory without the marker is a leftover; replace it.
      yield* fs.remove(modelDir(release.model), { recursive: true, force: true });
      yield* fs.rename(content, modelDir(release.model));
    }).pipe(Effect.scoped, orVoiceError("save"));

  const installWork = (release: WhisperCliRelease, model: WhisperModelRelease) =>
    Effect.gen(function* () {
      if (!(yield* isComplete(cliDir))) yield* installCli(release);
      if (!(yield* isComplete(modelDir(model.model)))) yield* installModel(model);
      // The new model is verified; drop the old one once no transcription reads it.
      yield* transcriptionPermit.withPermit(
        Effect.gen(function* () {
          yield* removeOthers(modelsDir, model.model).pipe(orVoiceError("save"));
          yield* SubscriptionRef.set(state, yield* installedStatus);
        }).pipe(Effect.uninterruptible),
      );
    });

  const install: VoiceInput["Service"]["install"] = (model) =>
    gate.withPermit(
      Effect.gen(function* () {
        if (cli === null) return yield* voiceError("unsupported");
        const current = yield* SubscriptionRef.get(state);
        if (current.phase === "downloading") return yield* voiceError("busy-install");
        if (current.phase === "ready" && current.model === model) return current;
        const release = modelRelease(model);
        const next: VoiceInputStatus = {
          ...current,
          phase: "downloading",
          pendingModel: model,
          downloadedBytes: 0,
          totalBytes: release.sizeBytes,
          message: null,
        };
        yield* SubscriptionRef.set(state, next);
        const work = installWork(cli, release).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.gen(function* () {
                  // Stopped after the new model was placed but before the old
                  // one was removed: keep the previous model.
                  const marked = yield* markedModels;
                  if (marked.includes(model) && marked.some((other) => other !== model)) {
                    yield* removeModel(model);
                  }
                  const installed = yield* installedStatus;
                  const error = Cause.findErrorOption(exit.cause);
                  yield* SubscriptionRef.set(
                    state,
                    Cause.hasInterruptsOnly(exit.cause)
                      ? installed
                      : {
                          ...installed,
                          phase: "failed",
                          message: Option.isSome(error) ? error.value.detail : MESSAGES.save,
                        },
                  );
                }),
          ),
          Effect.ignoreCause,
        );
        running = yield* Effect.forkIn(Effect.interruptible(work), serviceScope);
        return next;
      }).pipe(
        Effect.uninterruptible,
        Effect.withSpan("VoiceInput.install", { attributes: { model } }),
      ),
    );

  /** Interrupts a running install and reports what is installed. */
  const stopInstall = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    if (current.phase !== "downloading" || !running) return;
    yield* Fiber.interrupt(running);
    // A fiber interrupted before it started never runs its exit handler.
    yield* SubscriptionRef.set(state, yield* installedStatus);
  });

  const cancelInstall = gate.withPermit(
    stopInstall.pipe(Effect.andThen(SubscriptionRef.get(state))),
  );

  const remove = gate.withPermit(
    Effect.gen(function* () {
      yield* stopInstall;
      return yield* transcriptionPermit.withPermit(
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            yield* fs.remove(modelsDir, { recursive: true, force: true });
            yield* fs.remove(cliParent, { recursive: true, force: true });
          }).pipe(orVoiceError("save"));
          const next = yield* installedStatus;
          yield* SubscriptionRef.set(state, next);
          return next;
        }),
      );
    }).pipe(Effect.uninterruptible, Effect.withSpan("VoiceInput.remove")),
  );

  const threads = Math.max(1, NodeOS.availableParallelism() - 1);
  const jobs = new Map<string, Fiber.Fiber<VoiceTranscribeResult, VoiceInputError>>();
  const uploadFile = (uploadId: string) => voiceUploadPath(path, options.voiceDir, uploadId);
  const removeUpload = (uploadId: string) =>
    fs.remove(uploadFile(uploadId), { force: true }).pipe(Effect.ignore);

  // Never takes `gate`: `remove` holds it while waiting for this permit.
  const runWhisper = (wav: string) =>
    transcriptionPermit
      .withPermit(
        Effect.gen(function* () {
          // The installed model, even while another downloads: the swap takes this permit.
          const current = yield* SubscriptionRef.get(state);
          if (cli === null || current.model === null || !(yield* isComplete(cliDir))) {
            return yield* voiceError("not-installed");
          }
          const executable = path.join(cliDir, ...cli.executable);
          const model = path.join(modelDir(current.model), modelRelease(current.model).fileName);
          const result = yield* runner.run({
            command: executable,
            args: whisperArgs({ model, wav, threads }),
            timeout: TRANSCRIBE_TIMEOUT,
            ...(cli.libraryDir ? { env: { LD_LIBRARY_PATH: path.dirname(executable) } } : {}),
          });
          if (result.code !== 0) {
            yield* Effect.logWarning("whisper-cli failed.", {
              code: result.code,
              stderr: result.stderr.slice(-2_000),
            });
            return yield* voiceError("transcription-failed");
          }
          return { text: cleanTranscript(result.stdout) };
        }),
      )
      .pipe(orVoiceError("transcription-failed"));

  const transcribe: VoiceInput["Service"]["transcribe"] = (uploadId) =>
    Effect.gen(function* () {
      if (!isVoiceUploadId(uploadId)) return yield* voiceError("upload-missing");
      const wav = uploadFile(uploadId);
      if (!(yield* fs.exists(wav).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* voiceError("upload-missing");
      }
      // A child fiber, so a disconnected caller also stops the process.
      const job = yield* Effect.forkChild(runWhisper(wav)).pipe(
        Effect.tap((fiber) => Effect.sync(() => jobs.set(uploadId, fiber))),
        Effect.uninterruptible,
      );
      const exit = yield* Fiber.await(job).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (jobs.get(uploadId) === job) jobs.delete(uploadId);
          }),
        ),
      );
      if (Exit.isSuccess(exit)) return exit.value;
      if (Cause.hasInterruptsOnly(exit.cause)) return yield* voiceError("cancelled");
      return yield* Effect.failCause(exit.cause);
    }).pipe(Effect.ensuring(removeUpload(uploadId)), Effect.withSpan("VoiceInput.transcribe"));

  const cancelTranscription: VoiceInput["Service"]["cancelTranscription"] = (uploadId) =>
    Effect.gen(function* () {
      if (!isVoiceUploadId(uploadId)) return;
      const job = jobs.get(uploadId);
      if (job) yield* Fiber.interrupt(job);
      // Also covers a cancel that arrives between upload and transcribe.
      yield* removeUpload(uploadId);
    });

  return VoiceInput.of({
    status: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    install,
    cancelInstall,
    remove,
    transcribe,
    cancelTranscription,
  });
});

export const layer = Layer.effect(
  VoiceInput,
  Effect.gen(function* () {
    return yield* makeVoiceInput({ voiceDir: yield* resolveVoiceDir });
  }),
).pipe(Layer.provide(ProcessRunner.layer));
