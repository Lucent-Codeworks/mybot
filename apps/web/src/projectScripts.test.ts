import { MAX_SCRIPT_ID_LENGTH } from "@t3tools/contracts";
import { shortcutLabelForCommand } from "./keybindings";
import { describe, expect, it } from "vite-plus/test";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";

import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptIdFromCommand,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  it("builds scripts with preview settings", () => {
    expect(
      buildProjectScript("dev", {
        name: "Dev server",
        command: "pnpm dev",
        icon: "debug",
        previewUrl: "http://localhost:5733",
        autoOpenPreview: true,
      }),
    ).toEqual({
      id: "dev",
      name: "Dev server",
      command: "pnpm dev",
      icon: "debug",
      previewUrl: "http://localhost:5733",
      autoOpenPreview: true,
    });
  });

  it("omits preview settings when no preview URL is configured", () => {
    expect(
      buildProjectScript("test", {
        name: "Test",
        command: "pnpm test",
        icon: "test",
        previewUrl: null,
        autoOpenPreview: false,
      }),
    ).toEqual({
      id: "test",
      name: "Test",
      command: "pnpm test",
      icon: "test",
    });
  });

  it("builds and parses script run commands", () => {
    const command = commandForProjectScript("lint");
    expect(command).toBe("script.lint.run");
    expect(projectScriptIdFromCommand(command ?? "")).toBe("lint");
    expect(projectScriptIdFromCommand("terminal.toggle")).toBeNull();
  });

  it.each(["install-javascript-dependencies", "A", "a.b", "a b", "-a", "", "a".repeat(25)])(
    "omits the shortcut for legacy script ID %j without crashing script menus",
    (id) => {
      const commands = ["lint", id, "test"].map(commandForProjectScript);
      expect(commands).toEqual(["script.lint.run", null, "script.test.run"]);
      expect(commands.map((command) => shortcutLabelForCommand([], command))).toEqual([
        null,
        null,
        null,
      ]);
    },
  );

  it("preserves the exact ID at the shortcut length limit", () => {
    const id = "a".repeat(MAX_SCRIPT_ID_LENGTH);
    expect(projectScriptIdFromCommand(commandForProjectScript(id) ?? "")).toBe(id);
  });

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("uses the first script as the primary run action", () => {
    const scripts = [
      {
        id: "dev",
        name: "Dev",
        command: "bun dev",
        icon: "play" as const,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
      },
    ];
    expect(primaryProjectScript(scripts)?.id).toBe("dev");
    expect(primaryProjectScript([])).toBeNull();
  });

  it("builds default runtime env for scripts", () => {
    const env = projectScriptRuntimeEnv({ project: { cwd: "/repo" } });

    expect(env).toMatchObject({ T3CODE_PROJECT_ROOT: "/repo" });
  });

  it("allows overriding runtime env values", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      extraEnv: {
        T3CODE_PROJECT_ROOT: "/custom-root",
        CUSTOM_FLAG: "1",
      },
    });

    expect(env.T3CODE_PROJECT_ROOT).toBe("/custom-root");
    expect(env.CUSTOM_FLAG).toBe("1");
  });
});
