import { describe, expect, it } from "vite-plus/test";
import { voiceInputFreezesEditor } from "@mybot/client-runtime/voice-input";

import type { VoiceInputStatus } from "@mybot/contracts";

import { resolveVoiceComposerPresentation, voiceSetupAlert } from "./voiceInputPresentation";

describe("resolveVoiceComposerPresentation", () => {
  it("maps voice states to stable composer actions and editor read-only state", () => {
    expect(
      resolveVoiceComposerPresentation({ phase: "idle", error: null, errorAction: null }, 0),
    ).toEqual({
      leadingAction: null,
      trailingAction: "mic",
      showsSend: true,
      statusKind: null,
      statusLabel: null,
      confirmationEnabled: false,
      keepsRecording: false,
    });
    expect(
      resolveVoiceComposerPresentation({ phase: "preparing", error: null, errorAction: null }, 0),
    ).toMatchObject({
      leadingAction: "cancel",
      trailingAction: "confirm",
      showsSend: false,
      statusLabel: "Preparing",
      confirmationEnabled: false,
    });
    expect(
      resolveVoiceComposerPresentation({ phase: "recording", error: null, errorAction: null }, 64),
    ).toMatchObject({
      leadingAction: "cancel",
      trailingAction: "confirm",
      showsSend: false,
      statusLabel: "Recording 1:04",
      confirmationEnabled: true,
    });
    expect(
      resolveVoiceComposerPresentation(
        { phase: "transcribing", error: null, errorAction: null },
        0,
      ),
    ).toMatchObject({
      statusLabel: "Transcribing",
      confirmationEnabled: false,
    });
    expect(
      resolveVoiceComposerPresentation(
        { phase: "error", error: "Microphone unavailable", errorAction: "retry" },
        0,
      ),
    ).toMatchObject({
      leadingAction: null,
      trailingAction: "mic",
      showsSend: true,
      statusKind: "error",
      statusLabel: "Microphone unavailable",
    });

    expect(voiceInputFreezesEditor({ phase: "preparing", error: null, errorAction: null })).toBe(
      true,
    );
    expect(voiceInputFreezesEditor({ phase: "recording", error: null, errorAction: null })).toBe(
      true,
    );
    expect(voiceInputFreezesEditor({ phase: "transcribing", error: null, errorAction: null })).toBe(
      true,
    );
    expect(voiceInputFreezesEditor({ phase: "idle", error: null, errorAction: null })).toBe(false);
  });
});

describe("kept recordings", () => {
  it("offers retry and discard only when the recording was kept", () => {
    expect(
      resolveVoiceComposerPresentation(
        {
          phase: "error",
          error: "Could not transcribe this recording.",
          errorAction: "retry-transcription",
        },
        0,
      ).keepsRecording,
    ).toBe(true);
    expect(
      resolveVoiceComposerPresentation(
        { phase: "error", error: "No speech was detected.", errorAction: "retry" },
        0,
      ).keepsRecording,
    ).toBe(false);
  });
});

describe("voiceSetupAlert", () => {
  const status = (patch: Partial<VoiceInputStatus>): VoiceInputStatus => ({
    phase: "not-installed",
    model: null,
    pendingModel: null,
    downloadedBytes: 0,
    totalBytes: null,
    message: null,
    ...patch,
  });

  it("asks to download the speech model", () => {
    expect(voiceSetupAlert(status({}), true)).toEqual({
      message: "Voice input needs a speech model on your MyBot server (about 150 MB). Download it?",
      action: "Download",
    });
  });

  it("sends devices without permission to the server owner", () => {
    expect(voiceSetupAlert(status({}), false)).toEqual({
      message: "The MyBot server owner needs to turn on voice input.",
      action: null,
    });
  });

  it("shows a running download instead of starting another", () => {
    expect(
      voiceSetupAlert(
        status({ phase: "downloading", pendingModel: "base", downloadedBytes: 1, totalBytes: 4 }),
        true,
      ),
    ).toEqual({ message: "Downloading Base… 25%", action: null });
  });

  it("offers to retry a failed download with its reason", () => {
    expect(
      voiceSetupAlert(status({ phase: "failed", message: "Checksum mismatch" }), true),
    ).toEqual({ message: "Checksum mismatch", action: "Retry" });
  });
});
