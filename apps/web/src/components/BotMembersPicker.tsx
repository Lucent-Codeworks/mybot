import type { EnvironmentId, ProjectId } from "@mybot/contracts";
import { useMemo } from "react";

import { useProjects } from "../state/entities";
import { ProjectFavicon } from "./ProjectFavicon";
import { Checkbox } from "./ui/checkbox";

/** The bots a group chat can include: every bot on the environment except group chats. */
export function useGroupCandidates(environmentId: EnvironmentId, groupId: ProjectId | null) {
  const projects = useProjects();
  return useMemo(
    () =>
      projects.filter(
        (project) =>
          project.environmentId === environmentId &&
          project.bot != null &&
          project.bot.members === undefined &&
          project.id !== groupId,
      ),
    [projects, environmentId, groupId],
  );
}

/** Picks a group chat's bots. */
export function BotMembersPicker(props: {
  environmentId: EnvironmentId;
  groupId: ProjectId | null;
  value: ReadonlyArray<ProjectId>;
  disabled?: boolean;
  onChange: (members: ReadonlyArray<ProjectId>) => void;
}) {
  const candidates = useGroupCandidates(props.environmentId, props.groupId);
  if (candidates.length === 0) {
    return <p className="text-muted-foreground text-sm">Create a bot first to add it here.</p>;
  }
  const selected = new Set(props.value);
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="sr-only">Bots in this group</legend>
      {candidates.map((bot) => (
        <label
          key={bot.id}
          className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2"
        >
          <Checkbox
            checked={selected.has(bot.id)}
            disabled={props.disabled}
            onCheckedChange={(checked) =>
              props.onChange(
                checked
                  ? [...props.value, bot.id]
                  : props.value.filter((member) => member !== bot.id),
              )
            }
          />
          <ProjectFavicon project={bot} className="size-4" />
          <span className="min-w-0 flex-1 text-sm">
            {bot.title}
            {bot.bot?.role ? (
              <span className="text-muted-foreground"> · {bot.bot.role}</span>
            ) : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
