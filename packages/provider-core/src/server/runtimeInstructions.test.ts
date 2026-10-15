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
    expect(block).toContain("show the user exactly what you will do as a draft");
    expect(block).toContain("take control of the tab, finish the step, release control");
    expect(block).toContain("Never ask for passwords or one-time codes in chat.");
    expect(block).toContain("call preview_teach_start with the goal");
    expect(block).toContain("/mybot/skills/<short-name>/SKILL.md");
  });

  it("lists teammates the bot can message with bot_message", () => {
    const block = buildBotInstructions({
      name: "Scout",
      role: "",
      instructions: "",
      folder: "/bots/scout",
      skillsFolder: "/mybot/skills",
      teammates: [{ name: "Inbox", role: "Inbox triage", projectId: "project-inbox" }],
    });
    expect(block).toContain("- Inbox (Inbox triage)\n");
    expect(block).not.toContain("project-inbox");
    expect(block).toContain("call bot_message with its name");
    expect(block).toContain('"Message from <Name> (bot)" comes from another');
    expect(block).not.toContain("t3_thread_launch");
    expect(block).not.toContain("You are MyBot, the user's main assistant.");
  });

  it("tells the built-in MyBot to route work to the other bots", () => {
    const block = buildBotInstructions({
      name: "MyBot",
      role: "Your assistant",
      instructions: "",
      folder: "/bots/mybot",
      skillsFolder: "/mybot/skills",
      orchestrator: true,
      teammates: [{ name: "Inbox", role: "Inbox triage", projectId: "project-inbox" }],
    });
    expect(block).toContain(
      "You are MyBot, the user's main assistant. For each request, decide whether to do it yourself or to involve the bot whose job fits, with bot_message;",
    );
    expect(block).toContain("offer to create one with t3_project_create");
    expect(block).toContain("- Inbox (Inbox triage)");
  });

  it("hosts a group chat with its member bots", () => {
    const block = buildBotInstructions({
      name: "Team",
      role: "Group chat",
      instructions: "",
      folder: "/bots/team",
      skillsFolder: "/mybot/skills",
      teammates: [
        { name: "Scout", role: "Research", projectId: "project-scout" },
        { name: "Inbox", role: "Inbox triage", projectId: "project-inbox" },
      ],
      members: ["project-scout"],
    });
    expect(block).toContain("This is a group chat between the user and these bots");
    expect(block).toContain("- Scout (Research)\n");
    expect(block).not.toContain("Inbox");
    expect(block).toContain("Send each chosen bot the message with bot_message, by name");
    expect(block).not.toContain("t3_thread_send");
    expect(block).not.toContain("Message from <Name>");
  });
});
