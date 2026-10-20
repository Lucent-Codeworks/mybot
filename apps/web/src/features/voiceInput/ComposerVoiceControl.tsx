import { VOICE_RECORDING_LIMIT_SECONDS } from "@mybot/client-runtime/voice-input";
import { MicIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import type { ComposerVoiceInput } from "./useComposerVoiceInput";
import { INSECURE_VOICE_MESSAGE } from "./voiceInputAvailability";

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const LIMIT_LABEL = formatElapsed(VOICE_RECORDING_LIMIT_SECONDS);

/** Elapsed `m:ss / 5:00`, repainted once a second and only here, not the whole composer. */
function RecordingElapsed(props: { readonly startedAt: number }) {
  const [now, setNow] = useState(props.startedAt);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);
  const seconds = Math.min(
    VOICE_RECORDING_LIMIT_SECONDS,
    Math.max(0, Math.floor((now - props.startedAt) / 1000)),
  );
  return `${formatElapsed(seconds)} / ${LIMIT_LABEL}`;
}

/** The composer mic, and the recording bar that replaces it while voice input runs. */
export function ComposerVoiceControl(props: {
  readonly voice: ComposerVoiceInput;
  readonly shortcutLabel: string | null;
}) {
  const { voice } = props;
  if (voice.availability === "hidden" || voice.availability === "unsupported") return null;
  const { phase } = voice.state;

  if (phase === "recording" || phase === "transcribing") {
    const recording = phase === "recording";
    return (
      <div className="flex items-center gap-1" role="group" aria-label="Voice input">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onPointerDown={(event) => event.preventDefault()}
          onClick={voice.cancel}
          aria-label="Cancel voice input"
        >
          <XIcon />
        </Button>
        <span className="px-1 text-muted-foreground text-xs tabular-nums" role="timer">
          {recording && voice.recordingStartedAt !== null ? (
            <RecordingElapsed startedAt={voice.recordingStartedAt} />
          ) : (
            "Transcribing…"
          )}
        </span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={!recording}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => voice.stop("insert")}
        >
          Done
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={!recording}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => voice.stop("send")}
        >
          Send
        </Button>
      </div>
    );
  }

  const insecure = voice.availability === "insecure";
  const label = insecure
    ? INSECURE_VOICE_MESSAGE
    : props.shortcutLabel
      ? `Voice input (${props.shortcutLabel})`
      : "Voice input";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-disabled={insecure || phase === "preparing" ? true : undefined}
            onPointerDown={(event) => event.preventDefault()}
            onClick={voice.toggle}
            aria-label={insecure ? INSECURE_VOICE_MESSAGE : "Voice input"}
          />
        }
      >
        <MicIcon />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
