import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));

import * as MobileDatabase from "./mobile-database";

describe("mobile database legacy cache migration", () => {
  it.effect("keeps acquisition failures typed on database operations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        openDatabaseAsync.mockRejectedValueOnce(new Error("SQLite unavailable"));

        const database = yield* MobileDatabase.make;
        const result = yield* Effect.result(database.loadPreferencesJson);

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "MobileDatabaseError", operation: "open" },
        });
      }),
    ),
  );

  it("maps legacy thread records to their SQLite identity", () => {
    const payload = JSON.stringify({
      schemaVersion: 2,
      environmentId: "environment-1",
      threadId: "thread-1",
      snapshot: {},
    });

    expect(MobileDatabase.decodeLegacyCacheRecord("connection-thread-snapshots", payload)).toEqual({
      environmentId: "environment-1",
      kind: "thread",
      cacheKey: "thread-1",
      schemaVersion: 2,
      payload,
    });
  });

  it("preserves the old shell payload for schema decoding after migration", () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      environmentId: "environment-1",
      snapshotReceivedAt: "2026-07-01T00:00:00.000Z",
      snapshot: {},
    });

    expect(MobileDatabase.decodeLegacyCacheRecord("shell-snapshots", payload)).toEqual({
      environmentId: "environment-1",
      kind: "shell",
      cacheKey: "snapshot",
      schemaVersion: 1,
      payload,
    });
  });

  it("skips malformed legacy records", () => {
    expect(
      MobileDatabase.decodeLegacyCacheRecord("connection-thread-snapshots", "{not-json"),
    ).toBeNull();
    expect(
      MobileDatabase.decodeLegacyCacheRecord(
        "connection-thread-snapshots",
        JSON.stringify({ schemaVersion: 1, environmentId: "environment-1" }),
      ),
    ).toBeNull();
  });

  it("drops legacy source control records", () => {
    expect(
      MobileDatabase.decodeLegacyCacheRecord(
        "connection-vcs-refs",
        JSON.stringify({ schemaVersion: 1, environmentId: "environment-1", cwd: "/repo" }),
      ),
    ).toBeNull();
  });
});

// Exercise the production SQL against SQLite.
describe("client cache", () => {
  const environmentId = "cached-environment" as import("@t3tools/contracts").EnvironmentId;
  const otherEnvironment = "other-environment" as import("@t3tools/contracts").EnvironmentId;

  async function sqliteDatabase() {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA user_version = 1");
    const database = {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).get(...args),
      getAllAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).all(...args),
      withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
        await run(database);
      },
      closeAsync: async () => {
        sqlite.close();
      },
    };
    openDatabaseAsync.mockResolvedValueOnce(database);
    return sqlite;
  }

  it.effect("restores saved records and clears them with the environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(sqliteDatabase);
        const database = yield* MobileDatabase.make;
        yield* database.saveCache(environmentId, "thread", "thread-1", 1, '{"entries":[]}');
        yield* database.saveCache(otherEnvironment, "thread", "thread-1", 1, "other");
        expect(yield* database.loadCache(environmentId, "thread", "thread-1")).toEqual(
          Option.some('{"entries":[]}'),
        );
        yield* database.clearEnvironmentCache(environmentId);
        expect((yield* database.loadCache(environmentId, "thread", "thread-1"))._tag).toBe("None");
        expect((yield* database.loadCache(otherEnvironment, "thread", "thread-1"))._tag).toBe(
          "Some",
        );
      }),
    ),
  );

  it.effect("deletes cache rows of removed source control kinds on open", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sqlite = yield* Effect.promise(sqliteDatabase);
        sqlite.exec(`
          CREATE TABLE client_cache (
            environment_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            cache_key TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (environment_id, kind, cache_key)
          ) WITHOUT ROWID;
          INSERT INTO client_cache VALUES
            ('cached-environment', 'vcs-refs', '/repo', 1, '{}', 1),
            ('cached-environment', 'pull-request', '/repo', 1, '{}', 1),
            ('cached-environment', 'thread', 'thread-1', 1, '{}', 1);
        `);
        const database = yield* MobileDatabase.make;
        // Unknown kinds would fail to decode here if they survived.
        expect((yield* database.inspectCaches).map((row) => row.kind)).toEqual(["thread"]);
      }),
    ),
  );
});
