import { describe, expect, it } from "vite-plus/test";
import { buildBotInstructions, buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});

describe("buildBotInstructions", () => {
  it("names the bot and its role and carries the user's instructions verbatim", () => {
    const block = buildBotInstructions({
      name: "Scout",
      role: " Daily\ntech scout ",
      instructions: "  Check bookmarks.\n\nNever post without approval.  ",
    });
    expect(block).toBe(
      [
        "<bot_profile>",
        "You are Scout, Daily tech scout: a persistent teammate the user works with across many threads.",
        "Follow these standing instructions from the user:",
        "Check bookmarks.\n\nNever post without approval.",
        "</bot_profile>",
      ].join("\n"),
    );
  });

  it("leaves out an empty role and empty instructions", () => {
    const block = buildBotInstructions({ name: "Scout", role: "", instructions: " " });
    expect(block).toContain("You are Scout: a persistent teammate");
    expect(block).not.toContain("standing instructions");
  });

  it("follows the runtime block only for a bot's turns", () => {
    const bot = { name: "Scout", role: "", instructions: "" };
    expect(buildRuntimeInstructions({ harness: "Codex" })).not.toContain("<bot_profile>");
    expect(buildRuntimeInstructions({ harness: "Codex", bot })).toMatch(
      /<\/runtime_info>\n\n<bot_profile>/,
    );
  });
});
