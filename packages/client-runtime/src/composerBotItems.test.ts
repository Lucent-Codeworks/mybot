import { EnvironmentId, ProjectId } from "@mybot/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchComposerBotItems } from "./composerBotItems.ts";

const env = EnvironmentId.make("env-1");
const bot = (
  id: string,
  members?: ReadonlyArray<ProjectId>,
  environmentId: EnvironmentId = env,
) => ({
  environmentId,
  id: ProjectId.make(id),
  title: id,
  bot: { role: `${id} role`, instructions: "", ...(members ? { members } : {}) },
});

describe("matchComposerBotItems", () => {
  const bots = [
    bot("Host"),
    bot("Writer"),
    bot("Researcher"),
    bot("Team", [ProjectId.make("Writer")]),
    bot("Remote", undefined, EnvironmentId.make("env-2")),
    { environmentId: env, id: ProjectId.make("plain"), title: "Plain", bot: null },
  ];
  const match = (query: string) =>
    matchComposerBotItems({ bots, environmentId: env, excludeProjectId: bots[0]!.id, query }).map(
      (item) => item.label,
    );

  it("lists every other bot on this server for a bare @, never a group chat", () => {
    expect(match("")).toEqual(["Writer", "Researcher"]);
  });

  it("puts names that start with the query first", () => {
    expect(match("r")).toEqual(["Researcher", "Writer"]);
  });
});
