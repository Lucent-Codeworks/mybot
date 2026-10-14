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
      folder: "/bots/scout",
      skillsFolder: "/mybot/skills",
    });
    const lines = block.split("\n");
    expect(lines[0]).toBe("<bot_profile>");
    expect(lines[1]).toBe(
      "You are Scout, Daily tech scout: a persistent teammate the user works with across many threads.",
    );
    expect(block).toContain(
      "Follow these standing instructions from the user:\nCheck bookmarks.\n\nNever post without approval.\n</bot_profile>",
    );
  });

  it("leaves out an empty role and empty instructions", () => {
    const block = buildBotInstructions({
      name: "Scout",
      role: "",
      instructions: " ",
      folder: "/bots/scout",
      skillsFolder: "/mybot/skills",
    });
    expect(block).toContain("You are Scout: a persistent teammate");
    expect(block).not.toContain("standing instructions");
  });

  it("follows the runtime block only for a bot's turns", () => {
    const bot = {
      name: "Scout",
      role: "",
      instructions: "",
      folder: "/bots/scout",
      skillsFolder: "/mybot/skills",
    };
    expect(buildRuntimeInstructions({ harness: "Codex" })).not.toContain("<bot_profile>");
    expect(buildRuntimeInstructions({ harness: "Codex", bot })).toMatch(
      /<\/runtime_info>\n\n<bot_profile>/,
    );
  });

  it("points the bot at its memory file and forbids storing secrets", () => {
    const block = buildBotInstructions({
      name: "Scout",
      role: "",
      instructions: "",
      folder: "/bots/scout",
      skillsFolder: "/mybot/skills",
    });
    expect(block).toContain("Your memory is the file MEMORY.md in /bots/scout.");
    expect(block).toContain("never store secrets");
    expect(block).toContain("Saved skills are in /mybot/skills");
    expect(block).toContain("/mybot/skills/<short-name>/SKILL.md");
  });
});
