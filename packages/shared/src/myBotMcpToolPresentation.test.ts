import { describe, expect, it } from "vite-plus/test";

import {
  MYBOT_MCP_TOOL_NAMES,
  resolveMyBotMcpToolPresentation,
} from "./myBotMcpToolPresentation.ts";

describe("resolveMyBotMcpToolPresentation", () => {
  it("recognizes every MyBot tool across provider prefixes and completion suffixes", () => {
    for (const tool of MYBOT_MCP_TOOL_NAMES) {
      const presentation = resolveMyBotMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__t3-code__",
        "mcp__t3_code__",
        "mcp__t3code__",
        "T3-code.",
        "t3_code/",
        "t3code:",
        "mcp_t3-code_",
        "T3 Code ",
        "t3-code · ",
      ]) {
        expect(resolveMyBotMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveMyBotMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });
  it("pretty prints Claude and Cursor MyBot MCP tool names", () => {
    expect(resolveMyBotMcpToolPresentation("mcp__t3-code__t3_thread_read")).toEqual({
      displayName: "Read a MyBot thread",
      logo: "t3-code",
    });
  });

  it("pretty prints Codex MyBot MCP tool names", () => {
    expect(resolveMyBotMcpToolPresentation("t3-code.create_threads")).toEqual({
      displayName: "Create MyBot threads",
      logo: "t3-code",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(resolveMyBotMcpToolPresentation("mcp__t3-code__t3_thread_update")).toEqual({
      displayName: "Update MyBot thread metadata",
      logo: "t3-code",
    });
  });

  it("pretty prints bare MyBot MCP toolkit names", () => {
    expect(resolveMyBotMcpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "t3-code",
    });
  });

  it("pretty prints preview MyBot MCP tool names", () => {
    expect(resolveMyBotMcpToolPresentation("T3-code.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "t3-code",
    });
    expect(resolveMyBotMcpToolPresentation("mcp__t3-code__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "t3-code",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_t3-code_delegate_task",
      "t3_code:delegate_task",
      "t3code/delegate_task",
      "t3-code delegate_task",
      "T3 Code delegate_task",
      "t3-code__delegate_task",
    ]) {
      expect(resolveMyBotMcpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveMyBotMcpToolPresentation("t3-code-thread_opencode2-adapter_delegate_task")
        ?.displayName,
    ).toBe("Delegate a child task");
    expect(
      resolveMyBotMcpToolPresentation("t3-code-thread_opencode2-adapter_not_a_tool"),
    ).toBeNull();
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveMyBotMcpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolveMyBotMcpToolPresentation("t3-code.not_a_real_tool")).toBeNull();
  });
});
