import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { requestNewBot } from "../components/NewBotDialog";
import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { useProjects, useThreadShells } from "../state/entities";
import { useNewThreadHandler } from "./useHandleNewThread";

/** Every bot, most recently used first. */
export function useBotsByRecentUse(): ReadonlyArray<EnvironmentProject> {
  const projects = useProjects();
  const threads = useThreadShells();
  return useMemo(
    () =>
      sortScopedProjectsForSidebar(
        projects.filter((project) => project.bot != null),
        threads,
        "updated_at",
      ),
    [projects, threads],
  );
}

/**
 * Starts a new chat. With a bot, with that bot; otherwise with the most
 * recently used bot. With no bots at all, opens the New bot dialog.
 */
export function useStartBotChat() {
  const bots = useBotsByRecentUse();
  const handleNewThread = useNewThreadHandler();
  return useCallback(
    async (botRef?: ScopedProjectRef | null): Promise<void> => {
      const mostRecent = bots[0];
      const target =
        botRef ?? (mostRecent ? scopeProjectRef(mostRecent.environmentId, mostRecent.id) : null);
      if (target === null) {
        requestNewBot();
        return;
      }
      await handleNewThread(target);
    },
    [bots, handleNewThread],
  );
}
