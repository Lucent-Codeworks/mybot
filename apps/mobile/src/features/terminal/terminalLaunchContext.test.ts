import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  resolveTerminalOpenLocation,
  stagePendingTerminalLaunch,
  takePendingTerminalLaunch,
} from "./terminalLaunchContext";

describe("resolveTerminalOpenLocation", () => {
  it("opens a fresh terminal in the project folder", () => {
    expect(
      resolveTerminalOpenLocation({
        terminalLocation: null,
        activeSessionLocation: null,
        workspaceRoot: "/repo/root",
      }),
    ).toEqual({ cwd: "/repo/root" });
  });

  it("preserves the running terminal snapshot cwd when attaching to an existing session", () => {
    expect(
      resolveTerminalOpenLocation({
        terminalLocation: null,
        activeSessionLocation: {
          cwd: "/repo/packages/app",
        },
        workspaceRoot: "/repo/root",
      }),
    ).toEqual({
      cwd: "/repo/packages/app",
    });
  });
});

describe("pending terminal launches", () => {
  it("stages and consumes launch details for a specific terminal target", () => {
    const target = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-2",
    };

    stagePendingTerminalLaunch({
      target,
      launch: {
        cwd: "/repo/packages/app",
        env: { FOO: "bar" },
        initialInput: "pnpm dev\r",
      },
    });

    expect(takePendingTerminalLaunch(target)).toEqual({
      cwd: "/repo/packages/app",
      env: { FOO: "bar" },
      initialInput: "pnpm dev\r",
    });
    expect(takePendingTerminalLaunch(target)).toBeNull();
  });

  it("keeps pending launches isolated per terminal target", () => {
    const primaryTarget = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-2",
    };
    const otherTarget = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      terminalId: "term-3",
    };

    stagePendingTerminalLaunch({
      target: primaryTarget,
      launch: {
        cwd: "/repo/root",
        initialInput: "pnpm i\r",
      },
    });

    expect(takePendingTerminalLaunch(otherTarget)).toBeNull();
    expect(takePendingTerminalLaunch(primaryTarget)).toEqual({
      cwd: "/repo/root",
      env: undefined,
      initialInput: "pnpm i\r",
    });
  });
});
