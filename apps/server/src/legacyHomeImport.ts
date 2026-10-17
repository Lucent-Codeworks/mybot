import * as NodeSqlite from "node:sqlite";

import * as HostProcess from "@mybot/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Plain files carried over as-is. Identity, runtime, and cache files are left behind. */
const IMPORTED_FILES = [
  "settings.json",
  "client-settings.json",
  "keybindings.json",
  "keybindings-migrations",
  "model-manifest.json",
];
const IMPORTED_DIRECTORIES = ["themes", "attachments"];
/**
 * Provider API keys and env vars that settings.json references by name. The
 * rest of secrets/ (signing keys, cloud key pair, OAuth sessions whose refresh
 * tokens rotate) is this environment's identity and stays with T3 Code.
 */
const isImportedSecret = (name: string) =>
  name.endsWith(".bin") &&
  (name.startsWith("provider-config-") || name.startsWith("provider-env-"));

/**
 * Seeds `~/.mybot/userdata` once from an existing T3 Code `~/.t3/userdata`, so
 * a first MyBot start keeps the user's settings, projects, and threads. The
 * source is only read; databases are snapshotted through read-only
 * connections. Everything is staged next to the target and renamed into place,
 * and any failure just starts MyBot fresh.
 */
export const importLegacyT3Home = Effect.fn("importLegacyT3Home")(function* (input: {
  readonly baseDir: string;
  readonly stateDir: string;
  /** The desktop app's own local backend: it owns `~/.mybot` and never imports. */
  readonly launchedByLocalDesktop: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const defaultBaseDir = path.join(home, ".mybot");
  if (input.launchedByLocalDesktop) return;
  if (path.resolve(input.baseDir) !== defaultBaseDir) return;
  if (path.resolve(input.stateDir) !== path.join(defaultBaseDir, "userdata")) return;
  if (yield* fs.exists(input.stateDir)) return;
  const sourceDir = path.join(home, ".t3", "userdata");
  if (!(yield* fs.exists(sourceDir))) return;

  const stagingDir = path.join(defaultBaseDir, `.userdata.import-${process.pid}`);
  yield* Effect.gen(function* () {
    yield* fs.remove(stagingDir, { recursive: true, force: true });
    yield* fs.makeDirectory(stagingDir, { recursive: true });
    const imported: Array<string> = [];

    // V1 only matters when there is no V2 database to seed from.
    const databases = (yield* fs.exists(path.join(sourceDir, "statev2.sqlite")))
      ? ["statev2.sqlite"]
      : ["state.sqlite"];
    for (const name of databases) {
      const source = path.join(sourceDir, name);
      if (!(yield* fs.exists(source))) continue;
      const destination = path.join(stagingDir, name);
      yield* Effect.tryPromise(async () => {
        const database = new NodeSqlite.DatabaseSync(source, { readOnly: true });
        try {
          await NodeSqlite.backup(database, destination);
        } finally {
          database.close();
        }
      });
      yield* fs.chmod(destination, 0o600);
      imported.push(name);
    }

    const sourceEntries = yield* fs.readDirectory(sourceDir);
    const files = [
      ...IMPORTED_FILES,
      ...sourceEntries.filter((name) => name.startsWith("usage-") && name.endsWith(".json")),
    ];
    for (const name of [...files, ...IMPORTED_DIRECTORIES]) {
      const source = path.join(sourceDir, name);
      if (!(yield* fs.exists(source))) continue;
      yield* fs.copy(source, path.join(stagingDir, name), { preserveTimestamps: true });
      imported.push(name);
    }

    const secretsDir = path.join(sourceDir, "secrets");
    const secrets = (yield* fs.exists(secretsDir))
      ? (yield* fs.readDirectory(secretsDir)).filter(isImportedSecret)
      : [];
    if (secrets.length > 0) {
      const stagedSecretsDir = path.join(stagingDir, "secrets");
      yield* fs.makeDirectory(stagedSecretsDir, { mode: 0o700 });
      for (const name of secrets) {
        const destination = path.join(stagedSecretsDir, name);
        yield* fs.copyFile(path.join(secretsDir, name), destination);
        yield* fs.chmod(destination, 0o600);
      }
      imported.push(`${secrets.length} provider credential(s)`);
    }

    yield* fs.rename(stagingDir, input.stateDir);
    yield* Effect.logInfo(
      `Imported T3 Code data from ${sourceDir} into ${input.stateDir}: ${imported.join(", ") || "nothing"}.`,
    );
  }).pipe(
    Effect.catchCause((cause) =>
      fs
        .remove(stagingDir, { recursive: true, force: true })
        .pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.logWarning("Could not import T3 Code data; starting MyBot fresh.", cause),
          ),
        ),
    ),
  );
});
