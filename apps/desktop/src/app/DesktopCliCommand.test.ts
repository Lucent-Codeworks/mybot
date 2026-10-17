import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopCliShim from "./DesktopCliShim.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const environmentFor = (
  path: Path.Path,
  input: { home: string; baseDir: string; platform?: NodeJS.Platform; isPackaged?: boolean },
) =>
  DesktopEnvironment.DesktopEnvironment.of({
    path,
    platform: input.platform ?? "linux",
    isPackaged: input.isPackaged ?? true,
    homeDirectory: input.home,
    baseDir: input.baseDir,
    stateDir: path.join(input.baseDir, "userdata"),
    serverRoot: "/opt/MyBot/resources/app.asar",
    appImagePath: Option.none(),
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

/** The service for a packaged app; the launcher is written on Install. */
const commandIn = (
  input: { home: string; baseDir?: string; platform?: NodeJS.Platform; isPackaged?: boolean },
  spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"],
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const baseDir = input.baseDir ?? path.join(input.home, ".t3");
    yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
    const make = DesktopCliCommand.make.pipe(
      Effect.provideService(
        DesktopEnvironment.DesktopEnvironment,
        environmentFor(path, { ...input, baseDir }),
      ),
    );
    return yield* spawner
      ? make.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      : make;
  });

/** A PowerShell that keeps the user's PATH in memory and can be told to fail reads. */
const fakePowerShell = (initial: string) => {
  const registry = { path: initial, failReads: false, writes: 0 };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const { options } = command as unknown as {
        readonly options: { readonly env?: Record<string, string> };
      };
      const env = options.env ?? {};
      let exitCode = 0;
      let stdout = "";
      if (env.T3_SET === "1") {
        registry.path = env.T3_PATH ?? "";
        registry.writes += 1;
      } else if (registry.failReads) {
        exitCode = 1;
      } else {
        stdout = Buffer.from(registry.path, "utf8").toString("base64");
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { registry, spawner };
};

// The machine's own PATH may already hold a mybot; each test sets the PATH it means.
const machinePath = process.env.PATH;
beforeEach(() => {
  process.env.PATH = "";
});
afterEach(() => {
  process.env.PATH = machinePath;
});

it.layer(NodeServices.layer)("DesktopCliCommand", (it) => {
  it.effect("links the launcher onto PATH and removes only that link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const command = yield* commandIn({ home });
      const link = path.join(home, ".local", "bin", "mybot");

      expect(yield* command.state).toEqual({ supported: true, installedPath: null, onPath: false });
      // Install writes the launcher itself, even when no local backend ever did.
      const installed = yield* command.install;
      expect(installed.installedPath).toBe(link);
      expect(yield* fs.readLink(link)).toBe(path.join(home, ".t3", "bin", "mybot"));
      expect((yield* command.install).installedPath).toBe(link);

      expect((yield* command.uninstall).installedPath).toBeNull();
      expect(yield* fs.exists(link)).toBe(false);
      // The launcher itself stays for setup commands.
      expect(yield* fs.exists(path.join(home, ".t3", "bin", "mybot"))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("never replaces or removes a mybot it did not create", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const command = yield* commandIn({ home });
      const theirs = path.join(home, ".local", "bin", "mybot");
      yield* fs.makeDirectory(path.dirname(theirs), { recursive: true });
      yield* fs.writeFileString(theirs, "npm's mybot\n");
      // Even a broken link in the next folder is someone else's.
      yield* fs.makeDirectory(path.join(home, "bin"), { recursive: true });
      yield* fs.symlink(path.join(home, "gone"), path.join(home, "bin", "mybot"));

      const error = yield* Effect.flip(command.install);
      expect(error.message).toContain("Another mybot command is already installed");
      yield* command.uninstall;
      expect(yield* fs.readFileString(theirs)).toBe("npm's mybot\n");
      expect(yield* fs.readLink(path.join(home, "bin", "mybot"))).toBe(path.join(home, "gone"));
    }).pipe(Effect.scoped),
  );

  it.effect("finds and removes a link left by a previous MyBot home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const before = yield* commandIn({ home, baseDir: path.join(home, "old-t3") });
      const link = (yield* before.install).installedPath;

      const after = yield* commandIn({ home, baseDir: path.join(home, "new-t3") });
      expect((yield* after.state).installedPath).toBe(link);
      // Installing again points the link at this home's launcher.
      expect((yield* after.install).installedPath).toBe(link);
      expect(yield* fs.readLink(link!)).toBe(path.join(home, "new-t3", "bin", "mybot"));
      yield* after.uninstall;
      expect(yield* fs.exists(path.join(home, ".local", "bin", "mybot"))).toBe(false);
      expect(yield* fs.exists(path.join(home, "bin", "mybot"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("does not read a large binary another mybot links to", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      // A big executable that happens to contain the marker text is still not ours.
      const binary = path.join(home, "native-t3");
      yield* fs.writeFileString(binary, `${"\0".repeat(64 * 1024)}${DesktopCliShim.MARKER}`);
      yield* fs.makeDirectory(path.join(home, ".local", "bin"), { recursive: true });
      yield* fs.symlink(binary, path.join(home, ".local", "bin", "mybot"));
      const command = yield* commandIn({ home });
      expect((yield* command.state).installedPath).toBeNull();
      yield* command.uninstall;
      expect(yield* fs.readLink(path.join(home, ".local", "bin", "mybot"))).toBe(binary);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to install behind another mybot that runs first", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shadow = path.join(home, "shadow");
      yield* fs.makeDirectory(shadow);
      yield* fs.writeFileString(path.join(shadow, "mybot"), "#!/bin/sh\n", { mode: 0o755 });
      process.env.PATH = [shadow, path.join(home, ".local", "bin")].join(":");

      const command = yield* commandIn({ home });
      const theirs = path.join(shadow, "mybot");
      expect((yield* command.state).shadowedBy).toBe(theirs);
      // A link behind it would never run, so nothing is created.
      const error = yield* Effect.flip(command.install);
      expect(error.message).toContain(theirs);
      expect(yield* fs.exists(path.join(home, ".local", "bin", "mybot"))).toBe(false);

      yield* fs.remove(theirs);
      const installed = yield* command.install;
      expect(installed).toMatchObject({
        onPath: true,
        installedPath: path.join(home, ".local", "bin", "mybot"),
      });
      expect(installed.shadowedBy).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("replaces its own installed t3 command with mybot on start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const oldLauncher = path.join(home, ".t3", "bin", "t3");
      const oldLink = path.join(home, ".local", "bin", "t3");
      yield* fs.makeDirectory(path.dirname(oldLauncher), { recursive: true });
      yield* fs.writeFileString(oldLauncher, `#!/bin/sh\n# ${DesktopCliShim.LEGACY_MARKER}\n`);
      yield* fs.makeDirectory(path.dirname(oldLink), { recursive: true });
      yield* fs.symlink(oldLauncher, oldLink);

      const command = yield* commandIn({ home });

      expect(yield* fs.exists(oldLink)).toBe(false);
      expect(yield* fs.exists(oldLauncher)).toBe(false);
      const link = path.join(home, ".local", "bin", "mybot");
      expect((yield* command.state).installedPath).toBe(link);
      expect(yield* fs.readLink(link)).toBe(path.join(home, ".t3", "bin", "mybot"));
    }).pipe(Effect.scoped),
  );

  it.effect("leaves a t3 it cannot prove it wrote, such as T3 Code's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      // T3 Code shares the T3 home and writes its own `t3` launcher there.
      const t3CodeLauncher = path.join(home, ".t3", "bin", "t3");
      const t3CodeContent =
        "#!/bin/sh\n# Written by T3 Code: runs the desktop app's bundled t3 CLI.\n";
      yield* fs.makeDirectory(path.dirname(t3CodeLauncher), { recursive: true });
      yield* fs.writeFileString(t3CodeLauncher, t3CodeContent);
      const t3CodeLink = path.join(home, ".local", "bin", "t3");
      yield* fs.makeDirectory(path.dirname(t3CodeLink), { recursive: true });
      yield* fs.symlink(t3CodeLauncher, t3CodeLink);
      const npmT3 = path.join(home, "bin", "t3");
      yield* fs.makeDirectory(path.dirname(npmT3), { recursive: true });
      yield* fs.writeFileString(npmT3, "npm's t3\n");

      const command = yield* commandIn({ home });
      yield* command.uninstall;

      expect(yield* fs.readFileString(t3CodeLauncher)).toBe(t3CodeContent);
      expect(yield* fs.readLink(t3CodeLink)).toBe(t3CodeLauncher);
      expect(yield* fs.readFileString(npmT3)).toBe("npm's t3\n");
      // Nothing of ours was installed, so nothing replaces it.
      expect((yield* command.state).installedPath).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("Remove also takes out a leftover t3 link of its own", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const command = yield* commandIn({ home });
      // Left by a previous T3 home after this run's startup cleanup.
      const oldLauncher = path.join(home, "old-t3", "bin", "t3");
      yield* fs.makeDirectory(path.dirname(oldLauncher), { recursive: true });
      yield* fs.writeFileString(oldLauncher, `#!/bin/sh\n# ${DesktopCliShim.LEGACY_MARKER}\n`);
      const oldLink = path.join(home, "bin", "t3");
      yield* fs.makeDirectory(path.dirname(oldLink), { recursive: true });
      yield* fs.symlink(oldLauncher, oldLink);

      yield* command.uninstall;
      expect(yield* fs.exists(oldLink)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("replaces its own Windows t3.cmd with mybot.cmd on start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const bin = path.join(home, ".t3", "bin");
      yield* fs.makeDirectory(bin, { recursive: true });
      yield* fs.writeFileString(
        path.join(bin, "t3.cmd"),
        `@echo off\r\nrem ${DesktopCliShim.LEGACY_MARKER}\r\n`,
      );
      // Install had added the launcher folder to PATH, which is all that stays installed.
      yield* fs.makeDirectory(path.join(home, ".t3", "userdata"), { recursive: true });
      yield* fs.writeFileString(path.join(home, ".t3", "userdata", "cli-command-path-entry"), bin);
      const { registry, spawner } = fakePowerShell(bin);

      yield* commandIn({ home, platform: "win32" }, spawner);

      expect(yield* fs.exists(path.join(bin, "t3.cmd"))).toBe(false);
      expect(yield* fs.readFileString(path.join(bin, "mybot.cmd"))).toContain(
        DesktopCliShim.MARKER,
      );
      expect(registry).toMatchObject({ path: bin, writes: 0 });
    }).pipe(Effect.scoped),
  );

  it.effect("leaves the Windows PATH alone when it cannot be read", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const userPath = "C:\\Users\\Me\\npm;%USERPROFILE%\\tools";
      const { registry, spawner } = fakePowerShell(userPath);
      const command = yield* commandIn({ home, platform: "win32" }, spawner);

      registry.failReads = true;
      const error = yield* Effect.flip(command.install);
      expect(error.message).toContain("left unchanged");
      expect(registry).toMatchObject({ path: userPath, writes: 0 });

      registry.failReads = false;
      const launcherDir = DesktopCliShim.launcherPath(
        environmentFor(yield* Path.Path, { home, baseDir: `${home}/.t3`, platform: "win32" }),
      ).replace(/[\\/]mybot\.cmd$/, "");
      yield* command.install;
      expect(registry.path).toBe(`${userPath};${launcherDir}`);
      yield* command.uninstall;
      expect(registry.path).toBe(userPath);
    }).pipe(Effect.scoped),
  );

  it.effect("does not claim or remove a Windows PATH entry the user added", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const launcherDir = path.dirname(
        DesktopCliShim.launcherPath(
          environmentFor(path, { home, baseDir: path.join(home, ".t3"), platform: "win32" }),
        ),
      );
      const userPath = `C:\\Tools;${launcherDir}`;
      const { registry, spawner } = fakePowerShell(userPath);
      const command = yield* commandIn({ home, platform: "win32" }, spawner);

      expect((yield* command.state).installedPath).toBeNull();
      yield* command.uninstall;
      expect(registry.path).toBe(userPath);
    }).pipe(Effect.scoped),
  );

  it.effect("offers nothing for a development build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const command = yield* commandIn({
        home: yield* fs.makeTempDirectoryScoped(),
        isPackaged: false,
      });
      expect((yield* command.state).supported).toBe(false);
    }).pipe(Effect.scoped),
  );
});
