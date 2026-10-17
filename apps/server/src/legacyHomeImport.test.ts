// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@mybot/shared/HostProcess";
import * as Effect from "effect/Effect";

import { importLegacyT3Home } from "./legacyHomeImport.ts";

const write = (file: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, contents);
};

// Excludes -shm: every WAL reader, read-only or not, records read marks in that
// shared-memory index. That is SQLite's locking protocol, not database content.
const digestTree = (root: string): Record<string, string> =>
  Object.fromEntries(
    NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.endsWith("-shm"))
      .map((entry) => {
        const file = NodePath.join(entry.parentPath, entry.name);
        const stat = NodeFS.statSync(file);
        const hash = NodeCrypto.createHash("sha256")
          .update(NodeFS.readFileSync(file))
          .digest("hex");
        return [NodePath.relative(root, file), `${hash}:${stat.mtimeMs}`];
      }),
  );

/** A T3 Code home whose live database still has rows in its WAL, held open like a running app. */
const makeT3Home = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mybot-legacy-import-"));
  const source = NodePath.join(home, ".t3", "userdata");
  NodeFS.mkdirSync(source, { recursive: true });
  const writer = new NodeSqlite.DatabaseSync(NodePath.join(source, "statev2.sqlite"));
  writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  writer.exec("CREATE TABLE projects (id TEXT PRIMARY KEY)");
  writer.exec("INSERT INTO projects VALUES ('alpha'), ('beta')");
  write(NodePath.join(source, "state.sqlite"), "v1");
  write(NodePath.join(source, "settings.json"), '{"theme":"dark"}');
  write(NodePath.join(source, "keybindings.json"), "[]");
  write(NodePath.join(source, "usage-model-rates.json"), "{}");
  write(NodePath.join(source, "attachments", "a.png"), "png");
  write(NodePath.join(source, "themes", "t.json"), "{}");
  write(NodePath.join(source, "environment-id"), "env-1");
  write(NodePath.join(source, "anonymous-id"), "anon");
  write(NodePath.join(source, "server-runtime.json"), "{}");
  write(NodePath.join(source, "server-owner.sqlite"), "");
  write(NodePath.join(source, "clerk-tokens.json"), "{}");
  write(NodePath.join(source, "desktop-settings.json"), "{}");
  write(NodePath.join(source, "logs", "server.log"), "log");
  write(NodePath.join(source, "secrets", "server-signing-key.bin"), "identity");
  write(NodePath.join(source, "secrets", "provider-auth-abc.bin"), "oauth");
  write(NodePath.join(source, "secrets", "provider-env-codex-OPENAI_API_KEY.bin"), "sk-test");
  return { home, source, writer };
};

const runImport = (home: string, overrides: { launchedByLocalDesktop?: boolean } = {}) =>
  importLegacyT3Home({
    baseDir: NodePath.join(home, ".mybot"),
    stateDir: NodePath.join(home, ".mybot", "userdata"),
    launchedByLocalDesktop: overrides.launchedByLocalDesktop ?? false,
  }).pipe(
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provide(NodeServices.layer),
  );

it.effect("copies user state from ~/.t3 into a missing ~/.mybot without touching the source", () =>
  Effect.gen(function* () {
    const { home, source, writer } = makeT3Home();
    const before = digestTree(source);
    yield* runImport(home);
    assert.deepStrictEqual(digestTree(source), before);
    writer.close();

    const target = NodePath.join(home, ".mybot", "userdata");
    const copied = NodeFS.readdirSync(target, { recursive: true }).map(String).toSorted();
    assert.deepStrictEqual(copied, [
      "attachments",
      "attachments/a.png",
      "keybindings.json",
      "secrets",
      "secrets/provider-env-codex-OPENAI_API_KEY.bin",
      "settings.json",
      "statev2.sqlite",
      "themes",
      "themes/t.json",
      "usage-model-rates.json",
    ]);
    const snapshot = new NodeSqlite.DatabaseSync(NodePath.join(target, "statev2.sqlite"), {
      readOnly: true,
    });
    assert.deepStrictEqual(
      snapshot
        .prepare("SELECT id FROM projects ORDER BY id")
        .all()
        .map((row) => row.id),
      ["alpha", "beta"],
    );
    snapshot.close();
    assert.deepStrictEqual(
      NodeFS.readdirSync(NodePath.join(home, ".mybot")).filter((name) => name.includes("import")),
      [],
    );
  }),
);

it.effect("leaves an existing ~/.mybot/userdata alone", () =>
  Effect.gen(function* () {
    const { home, writer } = makeT3Home();
    writer.close();
    write(NodePath.join(home, ".mybot", "userdata", "settings.json"), "mine");
    yield* runImport(home);
    assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(home, ".mybot", "userdata")), [
      "settings.json",
    ]);
  }),
);

it.effect("imports even when the SSH launcher already created ~/.mybot/runtime", () =>
  Effect.gen(function* () {
    const { home, writer } = makeT3Home();
    writer.close();
    NodeFS.mkdirSync(NodePath.join(home, ".mybot", "runtime", "versions"), { recursive: true });
    yield* runImport(home);
    assert.isTrue(NodeFS.existsSync(NodePath.join(home, ".mybot", "userdata", "settings.json")));
  }),
);

it.effect("skips the desktop app's local backend and non-default homes", () =>
  Effect.gen(function* () {
    const { home, writer } = makeT3Home();
    writer.close();
    yield* runImport(home, { launchedByLocalDesktop: true });
    yield* importLegacyT3Home({
      baseDir: NodePath.join(home, "elsewhere"),
      stateDir: NodePath.join(home, "elsewhere", "userdata"),
      launchedByLocalDesktop: false,
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provide(NodeServices.layer),
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(home, ".mybot")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(home, "elsewhere")));
  }),
);

it.effect("starts fresh when the snapshot fails", () =>
  Effect.gen(function* () {
    const { home, source, writer } = makeT3Home();
    writer.close();
    NodeFS.writeFileSync(NodePath.join(source, "statev2.sqlite"), "not a database");
    yield* runImport(home);
    assert.isFalse(NodeFS.existsSync(NodePath.join(home, ".mybot", "userdata")));
    assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(home, ".mybot")), []);
  }),
);
