import type { ProjectId } from "@mybot/contracts";
import { describe, expect, it } from "vite-plus/test";

import { answeringBot, formatBotMention, mentionedBotIds } from "./botMentions.ts";
import { projectComposerContextForProvider } from "./composerContextReferences.ts";

const id = (value: string) => value as ProjectId;
const bot = (value: string, members?: ReadonlyArray<string>) => ({
  id: id(value),
  title: value,
  bot: members === undefined ? {} : { members },
});

describe("bot mentions", () => {
  const scout = bot("scout");
  const writer = bot("writer");
  const team = bot("team", ["scout", "writer"]);
  const host = bot("host");
  const bots = [scout, writer, team, host];

  it("lists each mentioned bot once, in order", () => {
    const text = `${formatBotMention(writer)} ask ${formatBotMention(scout)} and ${formatBotMention(writer)}`;
    expect(mentionedBotIds(text)).toEqual(["writer", "scout"]);
  });

  it("lets the first mentioned bot answer, never the host or a group chat", () => {
    const text = `${formatBotMention(host)} ${formatBotMention(team)} ${formatBotMention(scout)} hi`;
    expect(answeringBot(text, bots, host.id)).toBe(scout);
    expect(answeringBot(`${formatBotMention(host)} hi`, bots, host.id)).toBeUndefined();
    expect(answeringBot("@scout hi", bots, host.id)).toBeUndefined();
  });

  it("ignores a mention of a bot that no longer exists", () => {
    expect(answeringBot(`${formatBotMention(bot("gone"))} hi`, bots, host.id)).toBeUndefined();
  });

  it("falls back to plain text for an id a link cannot carry", () => {
    expect(formatBotMention({ id: id("a/b"), title: "Odd" })).toBe("@Odd");
  });

  it("reads as @Name to the provider, with no context entry", () => {
    const text = `${formatBotMention({ id: id("scout"), title: "Scout" })} find flights`;
    expect(projectComposerContextForProvider({ text, records: [] })).toBe("@Scout find flights");
  });
});
