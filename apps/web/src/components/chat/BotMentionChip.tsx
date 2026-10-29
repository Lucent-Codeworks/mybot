import { BotIcon } from "lucide-react";

import { useProjects } from "~/state/entities";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { ProjectFavicon } from "../ProjectFavicon";

/**
 * Inline `@Name` chip for a bot mention, in the composer and in sent messages.
 * Shows the bot's live name and icon, so a renamed bot never shows a stale label.
 */
export function BotMentionChip(props: {
  projectId: string;
  label: string;
  copyMarkdown?: string | undefined;
}) {
  const bot = useProjects().find((project) => project.id === props.projectId);
  const name = bot?.title.trim() || props.label;
  return (
    <ContextChip kind="bot" aria-label={`Bot, ${name}`} data-markdown-copy={props.copyMarkdown}>
      {bot ? <ProjectFavicon project={bot} className="size-[1.17em] shrink-0" /> : <BotIcon />}
      <ContextChipLabel>@{name}</ContextChipLabel>
    </ContextChip>
  );
}
