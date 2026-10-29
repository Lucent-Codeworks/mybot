import { describe, expect, it } from "vite-plus/test";

import { LARGE_APP_TOOLS, listedTools } from "./handlers.ts";

const app = (count: number) => ({
  id: "app",
  name: "App",
  error: null,
  tools: Array.from({ length: count }, (_, index) => ({
    name: `tool_${index}`,
    description: `Tool ${index}.`,
    inputSchema: { type: "object" },
  })),
});

describe("app_tools_list", () => {
  it("shows a small app's descriptions across apps and its schemas on its own", () => {
    expect(listedTools(app(2), false, undefined).tools[0]).toEqual({
      name: "tool_0",
      description: "Tool 0.",
    });
    expect(listedTools(app(2), true, undefined).tools[0]).toEqual(app(2).tools[0]);
  });

  it("shows a large app's names across apps and its descriptions on its own", () => {
    const large = app(LARGE_APP_TOOLS + 1);
    expect(listedTools(large, false, undefined).tools[0]).toEqual({ name: "tool_0" });
    expect(listedTools(large, true, undefined).tools[0]).toEqual({
      name: "tool_0",
      description: "Tool 0.",
    });
  });

  it("gives the schemas of the tools asked for", () => {
    const large = app(LARGE_APP_TOOLS + 1);
    expect(listedTools(large, true, ["tool_3", "missing"]).tools).toEqual([large.tools[3]]);
  });
});
