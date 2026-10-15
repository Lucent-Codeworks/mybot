import { useMemo } from "react";

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";

/**
 * Settings uses the same logical projects as the sidebar, limited to bots
 * (plain projects are no longer supported), sorted by display name.
 */
export function useSettingsProjectGroups() {
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  return useMemo(() => {
    const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
    return buildSidebarProjectSnapshots({
      projects: projects.filter((project) => project.bot != null),
      primaryEnvironmentId,
      resolveEnvironmentLabel: (id) => labels.get(id) ?? null,
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [environments, primaryEnvironmentId, projects]);
}
