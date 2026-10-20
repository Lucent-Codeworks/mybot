import { useAtomValue } from "@effect/atom-react";
import {
  voiceDownloadPercent,
  voiceSetupStep,
  voiceStatusLabel,
  VOICE_OWNER_NOTICE,
  VOICE_SETUP_MESSAGE,
  VOICE_SETUP_TITLE,
} from "@mybot/client-runtime/voice-input";
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
import { useAtomCommand } from "../../state/use-atom-command";
import { useVoiceInputStatus, voiceInputEnvironment } from "../../state/voiceInput";
import { closeVoiceInputSetup, useVoiceSetupRequest } from "./voiceInputSetup";

/** Mounted once at the app root; shows the prompt `requestVoiceInputSetup` asks for. */
export function VoiceSetupDialogHost() {
  const environmentId = useVoiceSetupRequest((state) => state.environmentId);
  useEffect(() => closeVoiceInputSetup, []);
  return environmentId ? <VoiceSetupDialog environmentId={environmentId} /> : null;
}

function VoiceSetupDialog({ environmentId }: { environmentId: EnvironmentId }) {
  const status = useVoiceInputStatus(environmentId);
  const canInstall = useAtomValue(voiceInputEnvironment.install.permissionAtom(environmentId));
  const canCancel = useAtomValue(voiceInputEnvironment.cancelInstall.permissionAtom(environmentId));
  const install = useAtomCommand(voiceInputEnvironment.install, { label: "voice model download" });
  const cancelInstall = useAtomCommand(voiceInputEnvironment.cancelInstall, {
    label: "voice model cancel",
  });
  const [requested, setRequested] = useState(false);
  const step = voiceSetupStep(status, requested);
  const downloading = step === "downloading";

  // Ready closes the prompt without recording; the user taps the mic again.
  useEffect(() => {
    if (step === "close") closeVoiceInputSetup();
  }, [step]);

  const percent = status ? voiceDownloadPercent(status) : null;
  return (
    <Dialog open onOpenChange={(open) => !open && closeVoiceInputSetup()}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{VOICE_SETUP_TITLE}</DialogTitle>
          <DialogDescription>
            {downloading || step === "starting"
              ? status
                ? voiceStatusLabel(status)
                : "Starting…"
              : step === "unsupported" && status
                ? voiceStatusLabel(status)
                : VOICE_SETUP_MESSAGE}
          </DialogDescription>
          {!canInstall && !downloading ? (
            <p className="text-muted-foreground text-sm">{VOICE_OWNER_NOTICE}</p>
          ) : null}
          {step === "failed" && status?.message ? (
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
              disabled={!canCancel}
            >
              Cancel download
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={closeVoiceInputSetup}>
                Not now
              </Button>
              <Button
                disabled={!canInstall || step === "unsupported" || step === "starting"}
                onClick={() => {
                  setRequested(true);
                  void install({ environmentId, input: { model: DEFAULT_VOICE_MODEL } }).then(
                    (result) => {
                      if (result._tag !== "Success") setRequested(false);
                    },
                  );
                }}
              >
                {step === "failed" ? "Retry" : "Download"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
