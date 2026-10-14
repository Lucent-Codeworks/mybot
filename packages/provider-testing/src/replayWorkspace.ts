import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Workspace-relative path to file contents, written beside the initial README. */
export type ReplayWorkspaceFiles = Readonly<Record<string, string>>;

const makeCheckpointWorkspaceEffect = Effect.fn("makeCheckpointWorkspace")(function* (
  fixtureName: string,
  files: ReplayWorkspaceFiles = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory({
    prefix: `t3-orchestrator-v2-${fixtureName}-`,
  });
  yield* fs.writeFileString(path.join(cwd, "README.md"), `# ${fixtureName}\n`);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(cwd, relativePath);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, contents);
  }
  return cwd;
});

const removeCheckpointWorkspaceEffect = Effect.fn("removeCheckpointWorkspace")(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(cwd, { recursive: true });
});

export const checkpointWorkspace = (fixtureName: string, files?: ReplayWorkspaceFiles) =>
  Effect.acquireRelease(makeCheckpointWorkspaceEffect(fixtureName, files), (cwd) =>
    removeCheckpointWorkspaceEffect(cwd).pipe(Effect.orDie),
  ).pipe(Effect.provide(NodeServices.layer));

export async function makeCheckpointWorkspace(
  fixtureName: string,
  files?: ReplayWorkspaceFiles,
): Promise<string> {
  return await Effect.runPromise(
    makeCheckpointWorkspaceEffect(fixtureName, files).pipe(Effect.provide(NodeServices.layer)),
  );
}
