import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, StorageCleanupReport } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import { ServerActivation } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as StorageCleanup from "./storageCleanup.ts";

const decodeCleanupReport = Schema.decodeSync(StorageCleanupReport);

const cleanupFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  let settings: import("@t3tools/contracts").ServerSettings = DEFAULT_SERVER_SETTINGS;
  const context = yield* Layer.build(StorageCleanup.layer).pipe(
    Effect.provideService(Settings.ServerSettingsService, {
      getSettings: Effect.sync(() => settings),
      subscribeChanges: Effect.succeed(Stream.empty),
    } as unknown as Settings.ServerSettingsService["Service"]),
    Effect.provideService(ServerActivation, Effect.never),
  );
  return {
    service: Context.get(context, StorageCleanup.StorageCleanup),
    fs,
    config,
    enableFiles: () => {
      settings = {
        ...settings,
        storageCleanup: {
          ...settings.storageCleanup,
          browserArtifactsAfterDays: 8,
          logsAfterDays: 8,
        },
      };
    },
  };
});

const writeExpired = Effect.fn("writeExpired")(function* (file: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(file, contents);
  yield* fs.utimes(file, 1, 1);
});

const cleanupTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "storage-cleanup-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const runCleanupTest = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | ServerConfig.ServerConfig | Path.Path | Scope.Scope
  >,
) => effect.pipe(Effect.provide(cleanupTestLayer), Effect.scoped);

describe("storage cleanup reports and local file policies", () => {
  it("decodes reports from servers without size fields", () => {
    const report = decodeCleanupReport({
      trigger: "manual",
      startedAt: "2026-06-10T12:00:00.000Z",
      finishedAt: "2026-06-10T12:00:01.000Z",
      entries: [
        {
          kind: "logs",
          outcome: "removed",
          reason: "Removed",
          path: null,
          threadId: null,
          threadTitle: null,
        },
      ],
      counts: { removed: 1, kept: 0, failed: 0 },
      omittedCount: 0,
    });
    expect(report.bytesFreed).toBe(0);
    expect(report.entries[0]).toMatchObject({ bytes: null, files: null });
  });

  it.live("omits disabled categories", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service } = yield* cleanupFixture;
        expect(yield* service.latestReport).toBeNull();
        const report = yield* service.runNow;
        expect(report.trigger).toBe("manual");
        expect(report.entries).toEqual([]);
        expect(yield* service.latestReport).toEqual(report);
      }),
    ),
  );

  it.live("streams the current report and subsequent runs", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, enableFiles } = yield* cleanupFixture;
        enableFiles();
        const reports = yield* service.reports.pipe(
          Stream.take(2),
          Stream.tap((report) => (report === null ? service.runNow : Effect.void)),
          Stream.runCollect,
        );
        expect(reports[0]).toBeNull();
        expect(reports[1]).toEqual(yield* service.latestReport);
        expect(reports[1]?.counts).toEqual({ removed: 0, kept: 2, failed: 0 });
      }),
    ),
  );

  it.live("serializes concurrent requests and returns each run's report", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, config, enableFiles } = yield* cleanupFixture;
        enableFiles();
        yield* fs.makeDirectory(config.logsDir, { recursive: true });
        yield* writeExpired(`${config.logsDir}/server.log.1`, "log");
        const reports = yield* Effect.all([service.runNow, service.runNow], {
          concurrency: "unbounded",
        });
        yield* service.drain;
        expect(
          reports.flatMap((report) => report.entries).filter((entry) => entry.kind === "logs"),
        ).toMatchObject([{ outcome: "removed" }, { outcome: "kept" }]);
        expect(yield* service.latestReport).toEqual(reports[1]);
      }),
    ),
  );

  it.live("aggregates expired artifacts and rotated logs while retaining current logs", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, config, enableFiles } = yield* cleanupFixture;
        enableFiles();
        yield* fs.makeDirectory(config.browserArtifactsDir, { recursive: true });
        yield* fs.makeDirectory(config.logsDir, { recursive: true });
        for (const name of ["one.png", "two.webm"]) {
          yield* writeExpired(`${config.browserArtifactsDir}/${name}`, "capture");
        }
        for (const name of ["server.log.1", "server.log.2", "server.log"]) {
          yield* writeExpired(`${config.logsDir}/${name}`, "log");
        }
        const report = yield* service.runNow;
        expect(report.entries).toMatchObject([
          {
            kind: "browser-artifacts",
            outcome: "removed",
            reason: "Removed 2 browser artifacts",
            bytes: 14,
            files: 2,
          },
          {
            kind: "logs",
            outcome: "removed",
            reason: "Removed 2 rotated logs",
            bytes: 6,
            files: 2,
          },
        ]);
        expect(report.bytesFreed).toBe(20);
        expect(yield* fs.readDirectory(config.browserArtifactsDir)).toEqual([]);
        expect(yield* fs.exists(`${config.logsDir}/server.log`)).toBe(true);
        expect(yield* fs.exists(`${config.logsDir}/server.log.1`)).toBe(false);
        expect(yield* fs.exists(`${config.logsDir}/server.log.2`)).toBe(false);
      }),
    ),
  );

  it.live("reports a failed category without aborting the remaining ones", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        yield* fs.makeDirectory(config.browserArtifactsDir, { recursive: true });
        yield* fs.makeDirectory(config.logsDir, { recursive: true });
        yield* writeExpired(`${config.logsDir}/server.log.1`, "log");
        const browserArtifactsDir = yield* fs.realPath(config.browserArtifactsDir);
        const { service, enableFiles } = yield* cleanupFixture.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory, options) =>
              directory === browserArtifactsDir
                ? fs.readDirectory(`${directory}/missing-directory`, options)
                : fs.readDirectory(directory, options),
          }),
        );
        enableFiles();
        const report = yield* service.runNow;
        expect(report.entries).toMatchObject([
          { kind: "browser-artifacts", outcome: "failed" },
          { kind: "logs", outcome: "removed", files: 1 },
        ]);
        expect(report.counts).toEqual({ removed: 1, kept: 0, failed: 1 });
      }),
    ),
  );
});
