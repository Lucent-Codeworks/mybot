import type { DesktopUpdateState } from "@t3tools/contracts";

import { getDesktopUpdateReleaseUrl } from "./desktopUpdate.logic";
import { openDesktopUpdateReleaseNotes } from "./desktopUpdate.toast";
import { UpdateReleaseNotesList } from "./sidebar/SidebarUpdateReleaseNotes";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

interface DesktopUpdateReviewDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly state: DesktopUpdateState | null;
  readonly onConfirm: () => void;
}

/**
 * Shows an available update's changelog before anything downloads. Confirming
 * hands off to the normal download, which then offers the restart as before.
 */
export function DesktopUpdateReviewDialog({
  open,
  onOpenChange,
  state,
  onConfirm,
}: DesktopUpdateReviewDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        {state ? <DesktopUpdateReviewContent state={state} onConfirm={onConfirm} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function DesktopUpdateReviewContent({
  state,
  onConfirm,
}: Pick<DesktopUpdateReviewDialogProps, "onConfirm"> & { readonly state: DesktopUpdateState }) {
  const version = state.availableVersion;
  const releaseUrl = getDesktopUpdateReleaseUrl(version);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{version ? `MyBot ${version} is available` : "Update available"}</DialogTitle>
        <DialogDescription>
          {`You're on ${state.currentVersion}. Review what's new, then update now or later.`}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {state.releaseNotes.length > 0 ? (
          <UpdateReleaseNotesList shell={window.desktopBridge} state={state} />
        ) : (
          <p className="text-sm text-muted-foreground">
            No release notes were published with this update.
            {releaseUrl ? (
              <>
                {" "}
                <a
                  className="underline underline-offset-4 hover:text-foreground"
                  href={releaseUrl}
                  onClick={(event) => {
                    event.preventDefault();
                    void openDesktopUpdateReleaseNotes(window.desktopBridge, releaseUrl);
                  }}
                >
                  View the release on GitHub
                </a>
              </>
            ) : null}
          </p>
        )}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Later</DialogClose>
        <Button onClick={onConfirm}>Update now</Button>
      </DialogFooter>
    </>
  );
}
