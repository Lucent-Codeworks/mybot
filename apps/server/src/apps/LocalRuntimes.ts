// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as NodeCrypto from "node:crypto";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import type { McpTransportConfig } from "./mcpClient.ts";

/**
 * The Node.js and uv that local apps run on. Catalog apps start with `npx` or
 * `uvx`; MyBot always runs those with its own pinned runtimes, downloaded into
 * <baseDir>/runtimes on first use, so users install nothing. To bump a pin,
 * change the version and copy every archive's SHA-256 from the release's
 * checksums (Node: dist/v<version>/SHASUMS256.txt, uv: each asset's .sha256).
 */
const NODE_VERSION = "24.22.0";
const NODE_ARCHIVES = {
  "darwin-arm64": "6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5",
  "darwin-x64": "495e3f273c645f3c4677d438304cdfc701729ea5dec5728f5c8e76a2dece4b91",
  "linux-arm64": "b7e7991d5407815adfa74a2a9cd4db683552c8ce32ff4a295c22e972849c3f5d",
  "linux-x64": "28ea0a438de9a13bd7891fd758eee6c7819ee8af5442dfd8d45bd65e56d4228c",
  "win-arm64": "3a5c209a5bc59e65b3bc0fa13ed5e166a26bd3d55332847f498b76b037408d61",
  "win-x64": "f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3",
} as const;

const UV_VERSION = "0.13.1";
const UV_ARCHIVES = {
  "aarch64-apple-darwin": "cfe454573412ff7380d15fc7dae5997ab53ffce72fce0a78e91ddbc84001acd2",
  "x86_64-apple-darwin": "bb7b805bdcf3d0bc8c74ceb94569e6b3e8aa35bd492acdbb9d46bf46d9d4ff6b",
  "x86_64-unknown-linux-gnu": "eadd9d27c134ab5ac1ffd4473b97a741407f3ea238288f03121fc4deddf90220",
  "aarch64-unknown-linux-gnu": "9041c73c99fdc5892cf128140beb354eca9231d502068cc36e6cb53a8e59ad14",
  "x86_64-pc-windows-msvc": "3b2661a463a5baea7f5076ea2b25ab71d77f36a6c0d809e5350651792f80a672",
  "aarch64-pc-windows-msvc": "ec7846a5939b4654afee24f2d82bf6fde71bd7a6952d7748f1135ab301dd0a49",
} as const;

/** Written into a runtime's directory before it is renamed into place. */
const INSTALLED_MARKER = ".mybot-installed";
/** Setup includes the download, so it gets its own bound beside the MCP handshake's. */
const SETUP_TIMEOUT = Duration.minutes(5);
const EXTRACT_TIMEOUT = Duration.minutes(2);
/** Far above any pinned archive (about 60 MB), so a broken mirror cannot fill the disk. */
const MAX_ARCHIVE_BYTES = 250_000_000;

export type LocalRuntime = "node" | "uv";

export interface LocalRuntimeRelease {
  readonly runtime: LocalRuntime;
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  /** The archive's top directory, which becomes the install; "" when files sit at its root. */
  readonly root: string;
  readonly format: "tar.gz" | "zip";
}

type StdioTransport = Extract<McpTransportConfig, { type: "stdio" }>;

const nodeKey = (platform: NodeJS.Platform, arch: NodeJS.Architecture) => {
  const os = platform === "win32" ? "win" : platform;
  const key = `${os}-${arch}`;
  return key in NODE_ARCHIVES ? (key as keyof typeof NODE_ARCHIVES) : null;
};

const uvTriple = (platform: NodeJS.Platform, arch: NodeJS.Architecture) => {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  const os =
    platform === "darwin"
      ? "apple-darwin"
      : platform === "linux"
        ? "unknown-linux-gnu"
        : platform === "win32"
          ? "pc-windows-msvc"
          : null;
  return cpu === null || os === null ? null : (`${cpu}-${os}` as keyof typeof UV_ARCHIVES);
};

/** The pinned archive of `runtime` for this computer, or null when there is none. */
const pinnedRelease = (
  runtime: LocalRuntime,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): LocalRuntimeRelease | null => {
  const format = platform === "win32" ? "zip" : "tar.gz";
  if (runtime === "node") {
    const key = nodeKey(platform, arch);
    if (key === null) return null;
    const name = `node-v${NODE_VERSION}-${key}`;
    return {
      runtime,
      version: NODE_VERSION,
      url: `https://nodejs.org/dist/v${NODE_VERSION}/${name}.${format}`,
      sha256: NODE_ARCHIVES[key],
      root: name,
      format,
    };
  }
  const triple = uvTriple(platform, arch);
  if (triple === null) return null;
  return {
    runtime,
    version: UV_VERSION,
    url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${triple}.${format}`,
    sha256: UV_ARCHIVES[triple],
    // The Windows zips hold the executables at their root.
    root: platform === "win32" ? "" : `uv-${triple}`,
    format,
  };
};

/** Which managed runtime a local app's command asks for, if any. */
export const runtimeForCommand = (command: string): LocalRuntime | null => {
  const name = command.toLowerCase();
  if (name === "npx" || name === "npx.cmd") return "node";
  if (name === "uvx" || name === "uvx.exe") return "uv";
  return null;
};

/** Files inside an install, relative to its directory. The first is what runs. */
const layout = (runtime: LocalRuntime, platform: NodeJS.Platform) => {
  const windows = platform === "win32";
  if (runtime === "uv") return { bin: [], files: [[windows ? "uvx.exe" : "uvx"]] };
  return windows
    ? { bin: [], files: [["node.exe"], ["node_modules", "npm", "bin", "npx-cli.js"]] }
    : {
        bin: ["bin"],
        files: [
          ["bin", "node"],
          ["lib", "node_modules", "npm", "bin", "npx-cli.js"],
        ],
      };
};

/**
 * Rewrites an `npx` or `uvx` command to run on the runtime installed at
 * `installDir`. Arguments, including `-y`, pass through unchanged. The
 * runtime's directory goes first on PATH, so `#!/usr/bin/env node` bins and
 * npm's Windows shims find MyBot's Node, and its caches live in `runtimesDir`.
 */
export const resolveStdio = (
  transport: StdioTransport,
  input: {
    readonly runtime: LocalRuntime;
    readonly installDir: string;
    readonly runtimesDir: string;
    readonly platform: NodeJS.Platform;
    /** PATH before the runtime is added: the app's configured one, else MyBot's. */
    readonly path: string | undefined;
  },
): StdioTransport => {
  const windows = input.platform === "win32";
  const join = (...parts: ReadonlyArray<string>) => parts.join(windows ? "\\" : "/");
  const { bin, files } = layout(input.runtime, input.platform);
  const binDir = join(input.installDir, ...bin);
  const path = input.path ? `${binDir}${windows ? ";" : ":"}${input.path}` : binDir;
  const [executable, script] = files.map((file) => join(input.installDir, ...file));
  if (input.runtime === "node") {
    return {
      ...transport,
      command: executable!,
      args: [script!, ...transport.args],
      env: {
        ...transport.env,
        PATH: path,
        npm_config_cache: join(input.runtimesDir, "npm-cache"),
        npm_config_update_notifier: "false",
      },
    };
  }
  return {
    ...transport,
    command: executable!,
    env: {
      ...transport.env,
      PATH: path,
      UV_CACHE_DIR: join(input.runtimesDir, "uv-cache"),
      UV_TOOL_DIR: join(input.runtimesDir, "uv-tools"),
      UV_PYTHON_INSTALL_DIR: join(input.runtimesDir, "uv-python"),
      // uv downloads its own Python into the directory above. A system Python
      // may be too old, and macOS's /usr/bin/python3 stub opens an installer.
      UV_PYTHON_PREFERENCE: "only-managed",
    },
  };
};

const RUNTIME_NAMES = { node: "Node.js", uv: "uv" } as const;

export class LocalRuntimeSetupError extends Schema.TaggedError<LocalRuntimeSetupError>()(
  "LocalRuntimeSetupError",
  {
    runtime: Schema.Literals(["node", "uv"]),
    reason: Schema.Literals(["unsupported", "download", "checksum", "unpack", "save", "timeout"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  get detail(): string {
    switch (this.reason) {
      case "unsupported":
        return "MyBot has no build of it for this kind of computer.";
      case "download":
        return "the download failed.";
      case "checksum":
        return "the download did not match the expected checksum, so it was not used.";
      case "unpack":
        return "the download could not be unpacked.";
      case "save":
        return "it could not be saved in MyBot's home directory.";
      case "timeout":
        return "the download took too long.";
    }
  }

  override get message(): string {
    return `Could not set up ${RUNTIME_NAMES[this.runtime]}: ${this.detail}`;
  }

  /** What the user reads when `app` could not start because of this. */
  messageFor(app: string): string {
    const hint =
      this.reason === "unsupported"
        ? ""
        : this.reason === "save" || this.reason === "unpack"
          ? " Check free disk space and try again."
          : " Check your internet connection and try again.";
    return `Could not set up ${RUNTIME_NAMES[this.runtime]} for ${app}: ${this.detail}${hint}`;
  }
}
const isSetupError = Schema.is(LocalRuntimeSetupError);

export class LocalRuntimes extends Context.Service<
  LocalRuntimes,
  {
    /**
     * Rewrites `npx` and `uvx` to MyBot's own Node.js and uv, installing the
     * runtime first if needed. Every other command passes through unchanged.
     */
    readonly prepare: (
      transport: StdioTransport,
    ) => Effect.Effect<StdioTransport, LocalRuntimeSetupError>;
  }
>()("mybot/apps/LocalRuntimes") {}

export interface LocalRuntimesOptions {
  readonly runtimesDir: string;
  /** Which archive to install; defaults to the pinned releases. */
  readonly release?: (runtime: LocalRuntime) => LocalRuntimeRelease | null;
}

export const makeLocalRuntimes = Effect.fn("LocalRuntimes.make")(function* (
  options: LocalRuntimesOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const hostEnv = yield* HostProcess.Environment;
  const { runtimesDir } = options;
  const releaseFor =
    options.release ?? ((runtime: LocalRuntime) => pinnedRelease(runtime, platform, arch));
  // One install at a time per runtime; later callers find it complete.
  const locks = { node: yield* Semaphore.make(1), uv: yield* Semaphore.make(1) };

  const fail =
    (release: LocalRuntimeRelease, reason: LocalRuntimeSetupError["reason"]) => (cause: unknown) =>
      isSetupError(cause)
        ? cause
        : new LocalRuntimeSetupError({ runtime: release.runtime, reason, cause });

  const isComplete = (dir: string) =>
    fs.exists(path.join(dir, INSTALLED_MARKER)).pipe(Effect.orElseSucceed(() => false));

  const download = Effect.fn("LocalRuntimes.download")(
    function* (release: LocalRuntimeRelease, archivePath: string) {
      const response = yield* http
        .execute(HttpClientRequest.get(release.url))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const hash = NodeCrypto.createHash("sha256");
      let received = 0;
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.suspend(() => {
            received += chunk.byteLength;
            if (received > MAX_ARCHIVE_BYTES) {
              return Effect.fail(
                new LocalRuntimeSetupError({ runtime: release.runtime, reason: "checksum" }),
              );
            }
            hash.update(chunk);
            return Effect.void;
          }),
        ),
        Stream.run(fs.sink(archivePath, { flag: "wx" })),
      );
      if (hash.digest("hex") !== release.sha256) {
        return yield* new LocalRuntimeSetupError({ runtime: release.runtime, reason: "checksum" });
      }
    },
    (effect, release) => Effect.mapError(effect, fail(release, "download")),
  );

  const unpack = Effect.fn("LocalRuntimes.unpack")(
    function* (release: LocalRuntimeRelease, archivePath: string, destination: string) {
      yield* fs.makeDirectory(destination);
      const result = yield* runner.run({
        command: cliArchiveTarCommand(platform, hostEnv),
        args: [release.format === "zip" ? "-xf" : "-xzf", archivePath, "-C", destination],
        timeout: EXTRACT_TIMEOUT,
      });
      if (result.code !== 0) {
        return yield* new LocalRuntimeSetupError({ runtime: release.runtime, reason: "unpack" });
      }
      const root = release.root ? path.join(destination, release.root) : destination;
      for (const file of layout(release.runtime, platform).files) {
        if (!(yield* fs.exists(path.join(root, ...file)))) {
          return yield* new LocalRuntimeSetupError({ runtime: release.runtime, reason: "unpack" });
        }
      }
      return root;
    },
    (effect, release) => Effect.mapError(effect, fail(release, "unpack")),
  );

  const install = Effect.fn("LocalRuntimes.install")(
    function* (release: LocalRuntimeRelease, installDir: string) {
      const parent = path.dirname(installDir);
      yield* fs.makeDirectory(parent, { recursive: true });
      // Staging shares the install's filesystem, so publishing is one rename.
      const staging = yield* fs.makeTempDirectoryScoped({ directory: parent, prefix: ".install-" });
      const archivePath = path.join(staging, `download.${release.format}`);
      yield* download(release, archivePath);
      const root = yield* unpack(release, archivePath, path.join(staging, "unpacked"));
      yield* fs.writeFileString(path.join(root, INSTALLED_MARKER), `${release.version}\n`);
      // A directory without the marker is a leftover; replace it.
      yield* fs.remove(installDir, { recursive: true, force: true });
      yield* fs.rename(root, installDir).pipe(
        // Another MyBot sharing this home may have published it first.
        Effect.catch((cause) =>
          isComplete(installDir).pipe(
            Effect.flatMap((done) => (done ? Effect.void : Effect.fail(cause))),
          ),
        ),
      );
      // Versions from earlier pins.
      for (const name of yield* fs.readDirectory(parent)) {
        if (name === release.version || name.startsWith(".")) continue;
        yield* fs
          .remove(path.join(parent, name), { recursive: true, force: true })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not remove an old app runtime.", { name, cause }),
            ),
          );
      }
    },
    Effect.scoped,
    (effect, release) => Effect.mapError(effect, fail(release, "save")),
  );

  const ensure = (release: LocalRuntimeRelease) => {
    const installDir = path.join(runtimesDir, release.runtime, release.version);
    return locks[release.runtime]
      .withPermit(
        isComplete(installDir).pipe(
          Effect.flatMap((done) => (done ? Effect.void : install(release, installDir))),
        ),
      )
      .pipe(
        Effect.as(installDir),
        Effect.timeoutOrElse({
          duration: SETUP_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new LocalRuntimeSetupError({ runtime: release.runtime, reason: "timeout" }),
            ),
        }),
      );
  };

  const prepare: LocalRuntimes["Service"]["prepare"] = (transport) => {
    const runtime = runtimeForCommand(transport.command);
    if (runtime === null) return Effect.succeed(transport);
    const release = releaseFor(runtime);
    if (release === null) {
      return Effect.fail(new LocalRuntimeSetupError({ runtime, reason: "unsupported" }));
    }
    return ensure(release).pipe(
      Effect.map((installDir) =>
        resolveStdio(transport, {
          runtime,
          installDir,
          runtimesDir,
          platform,
          path: transport.env?.PATH ?? hostEnv.PATH,
        }),
      ),
      Effect.withSpan("LocalRuntimes.prepare", { attributes: { runtime } }),
    );
  };

  return LocalRuntimes.of({ prepare });
});

export const layer = Layer.effect(
  LocalRuntimes,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* makeLocalRuntimes({ runtimesDir: path.join(config.baseDir, "runtimes") });
  }),
).pipe(Layer.provide(ProcessRunner.layer));
