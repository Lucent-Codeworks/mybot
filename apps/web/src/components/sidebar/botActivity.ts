import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";

/** What a bot's row shows: a conversation waits on the user, or one is working. */
export type BotActivity = "needs-you" | "working";

/** Each bot's activity across its conversations, keyed by its project group key. */
export function resolveBotActivity(
  bots: ReadonlyArray<{
    readonly projectKey: string;
    readonly memberProjectRefs: ReadonlyArray<{
      readonly environmentId: string;
      readonly projectId: string;
    }>;
  }>,
  threads: ReadonlyArray<
    Pick<
      SidebarThreadSummary,
      "environmentId" | "projectId" | "hasPendingApprovals" | "hasPendingUserInput" | "runtime"
    >
  >,
): ReadonlyMap<string, BotActivity> {
  const botByProject = new Map<string, string>();
  for (const bot of bots) {
    for (const ref of bot.memberProjectRefs) {
      botByProject.set(`${ref.environmentId}:${ref.projectId}`, bot.projectKey);
    }
  }
  const activity = new Map<string, BotActivity>();
  for (const thread of threads) {
    const botKey = botByProject.get(`${thread.environmentId}:${thread.projectId}`);
    if (botKey === undefined || activity.get(botKey) === "needs-you") continue;
    const status = resolveSidebarThreadStatus(thread);
    if (status === "approval" || status === "input") activity.set(botKey, "needs-you");
    else if (status === "working") activity.set(botKey, "working");
  }
  return activity;
}
