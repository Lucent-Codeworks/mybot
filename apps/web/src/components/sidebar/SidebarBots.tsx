import { PlugIcon, PlusIcon, SettingsIcon, SquarePenIcon } from "lucide-react";
import { memo, useState, type MouseEvent as ReactMouseEvent } from "react";

import { cn } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { BotActivity } from "./botActivity";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

const isOrchestrator = (group: SidebarProjectSnapshot) =>
  group.memberProjects.some((member) => member.bot?.orchestrator === true);

/** The project groups that are bots, in sidebar order, with the built-in MyBot first. */
export function botGroups(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
): ReadonlyArray<SidebarProjectSnapshot> {
  const bots = groups.filter((group) => group.memberProjects.some((member) => member.bot != null));
  return [...bots.filter(isOrchestrator), ...bots.filter((group) => !isOrchestrator(group))];
}

/**
 * Bots above the thread list. Selecting one scopes the threads to its
 * conversations; selecting it again shows every thread.
 */
export const SidebarBots = memo(function SidebarBots(props: {
  bots: ReadonlyArray<SidebarProjectSnapshot>;
  activity: ReadonlyMap<string, BotActivity>;
  scopedProjectKey: string | null;
  onToggleScope: (bot: SidebarProjectSnapshot) => void;
  onNewChat: (bot: SidebarProjectSnapshot) => void;
  onSettings: (event: ReactMouseEvent<HTMLElement>, bot: SidebarProjectSnapshot) => void;
  onNewBot: () => void;
  /** Opens the apps the bots can use. */
  onApps: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="mt-1">
      <CollapsibleSectionHeader expanded={expanded} onClick={() => setExpanded((open) => !open)}>
        Bots
      </CollapsibleSectionHeader>
      {expanded ? (
        <>
          {/* The bots live in the sidebar's fixed header, so a long list scrolls
              on its own instead of pushing the thread list out of view. */}
          <ScrollArea
            hideScrollbars
            scrollFade
            scrollFadePadding={false}
            className="h-auto max-h-[min(24rem,40dvh)]"
          >
            <SidebarMenu>
              {props.bots.map((bot) => {
                const role = bot.memberProjects.find((member) => member.bot)?.bot?.role ?? "";
                const activity = props.activity.get(bot.projectKey);
                return (
                  <SidebarMenuItem key={bot.projectKey} className="group/bot relative">
                    <SidebarMenuButton
                      isActive={props.scopedProjectKey === bot.projectKey}
                      title={role || bot.displayName}
                      onClick={() => props.onToggleScope(bot)}
                    >
                      <ProjectFavicon project={bot} className="size-4" />
                      <span className="min-w-0 flex-1">{bot.displayName}</span>
                      {activity ? (
                        <span
                          role="img"
                          aria-label={activity === "needs-you" ? "Waiting for you" : "Working"}
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            activity === "needs-you" ? "bg-warning" : "bg-info",
                          )}
                        />
                      ) : null}
                    </SidebarMenuButton>
                    <div className="absolute inset-y-0 right-1 hidden items-center gap-0.5 group-focus-within/bot:flex group-hover/bot:flex">
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`New chat with ${bot.displayName}`}
                        title={`New chat with ${bot.displayName}`}
                        onClick={() => props.onNewChat(bot)}
                      >
                        <SquarePenIcon />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Settings for ${bot.displayName}`}
                        title={`Settings for ${bot.displayName}`}
                        onClick={(event) => props.onSettings(event, bot)}
                      >
                        <SettingsIcon />
                      </Button>
                    </div>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </ScrollArea>
          <SidebarMenu className="mt-1">
            <SidebarMenuItem>
              <SidebarMenuButton onClick={props.onNewBot}>
                <PlusIcon />
                <span>New bot</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={props.onApps}>
                <PlugIcon />
                <span>Apps</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </>
      ) : null}
    </div>
  );
});
