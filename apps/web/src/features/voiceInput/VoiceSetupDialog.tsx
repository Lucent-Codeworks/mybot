import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_VOICE_MODEL, type EnvironmentId } from "@mybot/contracts";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  voiceDownloadPercent,
  voiceStatusLabel,
} from "../../components/settings/VoiceSettings.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { useVoiceInputStatus, voiceInputEnvironment } from "../../state/voiceInput";
import { closeVoiceInputSetup, useVoiceSetupRequest } from "./voiceInputSetup";

export const VOICE_OWNER_NOTICE = "The MyBot server owner needs to turn on voice input.";

/** Mounted once at the app root; shows the prompt `requestVoiceInputSetup` asks for. */
export function VoiceSetupDialogHost() {
  const environmentId = useVoiceSetupRequest((state) => state.environmentId);
  useEffect(() => closeVoiceInputSetup, []);
  return environmentId ? <VoiceSetupDialog environmentId={environmentId} /> : null;
}

function VoiceSetupDialog({ environmentId }: { environmentId: EnvironmentId }) {
  const status = useVoiceInputStatus(environmentId);
  const canInstall = useAtomValue(voiceInputEnvironment.install.permissionAtom(environmentId));
  const install = useAtomCommand(voiceInputEnvironment.install, { label: "voice model download" });
  const cancelInstall = useAtomCommand(voiceInputEnvironment.cancelInstall, {
    label: "voice model cancel",
  });
  const [started, setStarted] = useState(false);
  const downloading = status?.phase === "downloading";
  const ready = status?.phase === "ready" && status.model !== null;

  // Ready closes the prompt without recording; the user taps the mic again.
  useEffect(() => {
    if (ready) closeVoiceInputSetup();
  }, [ready]);

  const percent = status ? voiceDownloadPercent(status) : null;
  return (
    <Dialog open onOpenChange={(open) => !open && closeVoiceInputSetup()}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Set up voice input</DialogTitle>
          <DialogDescription>
            {downloading || started
              ? status
                ? voiceStatusLabel(status)
                : "Starting…"
              : status?.phase === "unsupported"
                ? voiceStatusLabel(status)
                : "Voice input needs a speech model on your MyBot server (about 150 MB). Download it?"}
          </DialogDescription>
          {!canInstall && !downloading ? (
            <p className="text-muted-foreground text-sm">{VOICE_OWNER_NOTICE}</p>
          ) : null}
          {status?.phase === "failed" && status.message && !started ? (
            <p className="text-destructive text-sm" role="alert">
              {status.message}
            </p>
          ) : null}
          {downloading && percent !== null ? (
            <progress className="w-full" max={100} value={percent} aria-label="Download progress" />
          ) : null}
        </DialogHeader>
        <DialogFooter>
          {downloading ? (
            <Button
              variant="outline"
              onClick={() => {
                void cancelInstall({ environmentId, input: {} });
                closeVoiceInputSetup();
              }}
              disabled={!canInstall}
            >
              Cancel download
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={closeVoiceInputSetup}>
                Not now
              </Button>
              <Button
                disabled={!canInstall || status?.phase === "unsupported" || started}
                onClick={() => {
                  setStarted(true);
                  void install({ environmentId, input: { model: DEFAULT_VOICE_MODEL } }).then(
                    (result) => {
                      if (result._tag !== "Success") setStarted(false);
                    },
                  );
                }}
              >
                Download
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
