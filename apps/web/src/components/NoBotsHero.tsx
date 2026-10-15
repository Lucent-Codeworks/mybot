import { PlusIcon } from "lucide-react";

import { isElectron } from "../env";
import { requestNewBot } from "./NewBotDialog";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

/** Shown where a chat would open while no bot exists yet. */
export function NoBotsHero() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <Empty size="hero" className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle>Create your first bot</EmptyTitle>
              <EmptyDescription>
                A bot is an AI teammate with its own job. Make one, then tell it what you need.
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button size="sm" onClick={requestNewBot}>
                  <PlusIcon className="size-4" />
                  New bot
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
