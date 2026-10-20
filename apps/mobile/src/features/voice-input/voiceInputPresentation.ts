import {
  voiceSetupStep,
  voiceStatusLabel,
  VOICE_OWNER_NOTICE,
  VOICE_SETUP_MESSAGE,
  type VoiceInputState,
} from "@mybot/client-runtime/voice-input";
import type { VoiceInputStatus } from "@mybot/contracts";

export type VoiceComposerPresentation = {
  readonly leadingAction: "cancel" | null;
  readonly trailingAction: "mic" | "confirm";
  readonly showsSend: boolean;
  readonly statusKind: "active" | "error" | null;
  readonly statusLabel: string | null;
  readonly confirmationEnabled: boolean;
  /** The recording survived a failed transcription: offer Retry and Discard. */
  readonly keepsRecording: boolean;
};

export function resolveVoiceComposerPresentation(
  state: VoiceInputState,
  elapsedSeconds: number,
): VoiceComposerPresentation {
  switch (state.phase) {
    case "idle":
      return {
        leadingAction: null,
        trailingAction: "mic",
        showsSend: true,
        statusKind: null,
        statusLabel: null,
        confirmationEnabled: false,
        keepsRecording: false,
      };
    case "error":
      return {
        leadingAction: null,
        trailingAction: "mic",
        showsSend: true,
        statusKind: "error",
        statusLabel: state.error,
        confirmationEnabled: false,
        keepsRecording: state.errorAction === "retry-transcription",
      };
    case "preparing":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: "Preparing",
        confirmationEnabled: false,
        keepsRecording: false,
      };
    case "recording": {
      const seconds = Math.max(0, Math.floor(elapsedSeconds));
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
        confirmationEnabled: true,
        keepsRecording: false,
      };
    }
    case "transcribing":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: "Transcribing",
        confirmationEnabled: false,
        keepsRecording: false,
      };
  }
}

export type VoiceSetupAlert = {
  readonly message: string;
  /** The button that installs the setup model, or null when there is nothing to do. */
  readonly action: "Download" | "Retry" | null;
};

/** What the first-use prompt says for a server without a usable speech model. */
export function voiceSetupAlert(
  status: VoiceInputStatus | null,
  canInstall: boolean,
): VoiceSetupAlert {
  const step = voiceSetupStep(status, false);
  if (status && (step === "downloading" || step === "unsupported" || step === "close")) {
    return { message: voiceStatusLabel(status), action: null };
  }
  if (!canInstall) return { message: VOICE_OWNER_NOTICE, action: null };
  if (step === "failed") {
    return { message: status?.message ?? VOICE_SETUP_MESSAGE, action: "Retry" };
  }
  return { message: VOICE_SETUP_MESSAGE, action: "Download" };
}
