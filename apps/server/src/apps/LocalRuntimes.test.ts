import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import * as LocalRuntimes from "./LocalRuntimes.ts";

describe("resolveStdio", () => {
  const discord = {
    type: "stdio" as const,
    command: "npx",
    args: ["-y", "mcp-discord"],
    env: { DISCORD_TOKEN: "token" },
  };
  const fetchApp = { type: "stdio" as const, command: "uvx", args: ["mcp-server-fetch"] };

  it("runs npx as MyBot's node with npm's npx script on macOS and Linux", () => {
    expect(
      LocalRuntimes.resolveStdio(discord, {
        runtime: "node",
        installDir: "/home/me/.mybot/runtimes/node/24.0.0",
        runtimesDir: "/home/me/.mybot/runtimes",
        platform: "linux",
        path: "/usr/bin:/bin",
      }),
    ).toEqual({
      type: "stdio",
      command: "/home/me/.mybot/runtimes/node/24.0.0/bin/node",
      args: [
        "/home/me/.mybot/runtimes/node/24.0.0/lib/node_modules/npm/bin/npx-cli.js",
        "-y",
        "mcp-discord",
      ],
      env: {
        DISCORD_TOKEN: "token",
        PATH: "/home/me/.mybot/runtimes/node/24.0.0/bin:/usr/bin:/bin",
        npm_config_cache: "/home/me/.mybot/runtimes/npm-cache",
        npm_config_update_notifier: "false",
      },
    });
  });

  it("runs npx as MyBot's node.exe on Windows", () => {
    const resolved = LocalRuntimes.resolveStdio(discord, {
      runtime: "node",
      installDir: "C:\\Users\\me\\.mybot\\runtimes\\node\\24.0.0",
      runtimesDir: "C:\\Users\\me\\.mybot\\runtimes",
      platform: "win32",
      path: "C:\\Windows\\System32",
    });
    expect(resolved.command).toBe("C:\\Users\\me\\.mybot\\runtimes\\node\\24.0.0\\node.exe");
    expect(resolved.args).toEqual([
      "C:\\Users\\me\\.mybot\\runtimes\\node\\24.0.0\\node_modules\\npm\\bin\\npx-cli.js",
      "-y",
      "mcp-discord",
    ]);
    expect(resolved.env?.PATH).toBe(
      "C:\\Users\\me\\.mybot\\runtimes\\node\\24.0.0;C:\\Windows\\System32",
    );
    expect(resolved.env?.npm_config_cache).toBe("C:\\Users\\me\\.mybot\\runtimes\\npm-cache");
  });

  it("runs uvx from MyBot's uv with its own caches and Python", () => {
    expect(
      LocalRuntimes.resolveStdio(fetchApp, {
        runtime: "uv",
        installDir: "/r/uv/0.13.1",
        runtimesDir: "/r",
        platform: "darwin",
        path: undefined,
      }),
    ).toEqual({
      type: "stdio",
      command: "/r/uv/0.13.1/uvx",
      args: ["mcp-server-fetch"],
      env: {
        PATH: "/r/uv/0.13.1",
        UV_CACHE_DIR: "/r/uv-cache",
        UV_TOOL_DIR: "/r/uv-tools",
        UV_PYTHON_INSTALL_DIR: "/r/uv-python",
        UV_PYTHON_PREFERENCE: "only-managed",
      },
    });
    const windows = LocalRuntimes.resolveStdio(fetchApp, {
      runtime: "uv",
      installDir: "C:\\r\\uv\\0.13.1",
      runtimesDir: "C:\\r",
      platform: "win32",
      path: "C:\\Windows",
    });
    expect(windows.command).toBe("C:\\r\\uv\\0.13.1\\uvx.exe");
    expect(windows.env?.PATH).toBe("C:\\r\\uv\\0.13.1;C:\\Windows");
  });

  it("only takes over npx and uvx", () => {
    expect(LocalRuntimes.runtimeForCommand("npx")).toBe("node");
    expect(LocalRuntimes.runtimeForCommand("uvx")).toBe("uv");
    expect(LocalRuntimes.runtimeForCommand("docker")).toBeNull();
    expect(LocalRuntimes.runtimeForCommand("/usr/local/bin/npx")).toBeNull();
    expect(LocalRuntimes.runtimeForCommand("node")).toBeNull();
  });
});

const hostPlatform = HostProcess.Platform.defaultValue();
const windowsHost = hostPlatform === "win32";
const uvx = windowsHost ? "uvx.exe" : "uvx";

/** A real gzipped tarball shaped like uv's: one top directory holding uvx. */
const makeArchive = Effect.fn("test.makeArchive")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runtime-fixture-" });
  yield* fs.makeDirectory(path.join(dir, "uv-fixture"));
  yield* fs.writeFileString(path.join(dir, "uv-fixture", uvx), "#!/bin/sh\n", { mode: 0o755 });
  const archivePath = path.join(dir, "fixture.tar.gz");
  const result = yield* runner.run({
    command: cliArchiveTarCommand(hostPlatform, HostProcess.Environment.defaultValue()),
    args: ["-czf", archivePath, "-C", dir, "uv-fixture"],
  });
  expect(result.code).toBe(0);
  return yield* fs.readFile(archivePath);
});

const makeHarness = Effect.fn("test.makeLocalRuntimes")(function* (
  options: { readonly sha256?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const archive = yield* makeArchive();
  const runtimesDir = path.join(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3-runtimes-test-" }),
    "runtimes",
  );
  const sha256 = options.sha256 ?? Hex.encode(yield* crypto.digest("SHA-256", archive));
  const requests: Array<string> = [];
  const runtimes = yield* LocalRuntimes.makeLocalRuntimes({
    runtimesDir,
    release: (runtime) => ({
      runtime,
      version: "1.0.0",
      url: "https://downloads.example/uv-fixture.tar.gz",
      sha256,
      root: "uv-fixture",
      format: "tar.gz",
    }),
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          return HttpClientResponse.fromWeb(request, new Response(archive));
        }),
      ),
    ),
  );
  return { runtimes, fs, path, runtimesDir, requests };
});

const fetchApp = { type: "stdio" as const, command: "uvx", args: ["mcp-server-fetch"] };

it.layer(Layer.provideMerge(ProcessRunner.layer, NodeServices.layer))("LocalRuntimes", (it) => {
  it.effect("installs a verified runtime once and reuses it", () =>
    Effect.gen(function* () {
      const { runtimes, fs, path, runtimesDir, requests } = yield* makeHarness();
      const installDir = path.join(runtimesDir, "uv", "1.0.0");
      // A previous pin, and a directory an interrupted install left without its marker.
      yield* fs.makeDirectory(path.join(runtimesDir, "uv", "0.9.0"), { recursive: true });
      yield* fs.makeDirectory(installDir, { recursive: true });

      const first = yield* runtimes.prepare(fetchApp);
      const second = yield* runtimes.prepare(fetchApp);

      expect(requests).toEqual(["https://downloads.example/uv-fixture.tar.gz"]);
      expect(first.command).toBe(path.join(installDir, uvx));
      expect(first.args).toEqual(["mcp-server-fetch"]);
      expect(second).toEqual(first);
      expect(yield* fs.exists(first.command)).toBe(true);
      expect(yield* fs.readDirectory(path.join(runtimesDir, "uv"))).toEqual(["1.0.0"]);
    }).pipe(Effect.scoped),
  );

  it.effect("downloads once for concurrent connects", () =>
    Effect.gen(function* () {
      const { runtimes, requests } = yield* makeHarness();
      const results = yield* Effect.all(
        [runtimes.prepare(fetchApp), runtimes.prepare(fetchApp), runtimes.prepare(fetchApp)],
        { concurrency: "unbounded" },
      );
      expect(requests).toHaveLength(1);
      expect(new Set(results.map((result) => result.command)).size).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a download whose checksum does not match", () =>
    Effect.gen(function* () {
      const { runtimes, fs, path, runtimesDir, requests } = yield* makeHarness({
        sha256: "0".repeat(64),
      });
      const error = yield* runtimes.prepare(fetchApp).pipe(Effect.flip);
      expect(error).toBeInstanceOf(LocalRuntimes.LocalRuntimeSetupError);
      expect(error.reason).toBe("checksum");
      expect(error.messageFor("Fetch")).toBe(
        "Could not set up uv for Fetch: the download did not match the expected checksum, so it was not used. Check your internet connection and try again.",
      );
      // Nothing installed and no staging left behind; the next connect tries again.
      expect(yield* fs.readDirectory(path.join(runtimesDir, "uv"))).toEqual([]);
      yield* runtimes.prepare(fetchApp).pipe(Effect.flip);
      expect(requests).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("passes other commands through without downloading", () =>
    Effect.gen(function* () {
      const { runtimes, requests } = yield* makeHarness();
      const docker = { type: "stdio" as const, command: "docker", args: ["run", "-i", "x"] };
      expect(yield* runtimes.prepare(docker)).toBe(docker);
      expect(requests).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
