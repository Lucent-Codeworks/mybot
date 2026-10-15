import { describe, expect, it } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { botGroups } from "./SidebarBots";

const group = (
  projectKey: string,
  bot: { readonly orchestrator?: boolean } | null,
): SidebarProjectSnapshot =>
  ({
    projectKey,
    memberProjects: [{ bot: bot === null ? null : { role: "", instructions: "", ...bot } }],
  }) as unknown as SidebarProjectSnapshot;

describe("botGroups", () => {
  it("keeps only bots, with the built-in MyBot first", () => {
    const groups = [
      group("scout", {}),
      group("plain", null),
      group("mybot", { orchestrator: true }),
      group("inbox", {}),
    ];
    expect(botGroups(groups).map((entry) => entry.projectKey)).toEqual(["mybot", "scout", "inbox"]);
  });
});
