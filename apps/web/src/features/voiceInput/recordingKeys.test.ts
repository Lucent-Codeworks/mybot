import { voiceInputFreezesEditor } from "@mybot/client-runtime/voice-input";
import { describe, expect, it } from "vite-plus/test";

import { recordingKeyOutcome, type RecordingKeyTarget } from "./recordingKeys";

function key(key: string, target: RecordingKeyTarget, overrides: { terminalFocus?: boolean } = {}) {
  return recordingKeyOutcome({
    key,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    terminalFocus: overrides.terminalFocus ?? false,
    target,
  });
}

describe("recordingKeyOutcome", () => {
  it("stops from the composer or the page", () => {
    expect(key("Escape", "composer")).toBe("insert");
    expect(key("Enter", "composer")).toBe("send");
    expect(key("Enter", "page")).toBe("send");
  });

  it("leaves Enter to a focused composer button", () => {
    expect(key("Enter", "button")).toBeNull();
    expect(key("Escape", "button")).toBe("insert");
  });

  it("ignores keys meant for the terminal, a dialog, or another field", () => {
    expect(key("Enter", "composer", { terminalFocus: true })).toBeNull();
    expect(key("Escape", "page", { terminalFocus: true })).toBeNull();
    expect(key("Escape", "overlay")).toBeNull();
    expect(key("Enter", "overlay")).toBeNull();
    expect(key("Enter", "editable")).toBeNull();
  });

  it("ignores modified Enter and IME composition", () => {
    expect(
      recordingKeyOutcome({
        key: "Enter",
        shiftKey: true,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        isComposing: false,
        terminalFocus: false,
        target: "composer",
      }),
    ).toBeNull();
    expect(
      recordingKeyOutcome({
        key: "Enter",
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        isComposing: true,
        terminalFocus: false,
        target: "composer",
      }),
    ).toBeNull();
  });
});

describe("composer editor freeze", () => {
  it("is read-only while voice input can still write the draft", () => {
    for (const phase of ["preparing", "recording", "transcribing"] as const) {
      expect(voiceInputFreezesEditor({ phase, error: null, errorAction: null })).toBe(true);
    }
    expect(
      voiceInputFreezesEditor({
        phase: "error",
        error: "Could not transcribe this recording.",
        errorAction: "retry-transcription",
      }),
    ).toBe(false);
  });
});
