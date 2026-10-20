import type { VoiceInputOutcome } from "@mybot/client-runtime/voice-input";

/**
 * Where a key event landed while recording: in the composer (`button` for a
 * focused composer button), in an overlay such as a dialog or menu, in some
 * other text field, or nowhere in particular (`page`, e.g. the body).
 */
export type RecordingKeyTarget = "composer" | "button" | "overlay" | "editable" | "page";

/**
 * Esc stops and inserts and Enter stops and sends, but only for keys meant
 * for the composer: never in the terminal, a dialog, or another text field.
 */
export function recordingKeyOutcome(input: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly isComposing: boolean;
  readonly terminalFocus: boolean;
  readonly target: RecordingKeyTarget;
}): VoiceInputOutcome | null {
  if (input.isComposing || input.terminalFocus) return null;
  if (input.target === "overlay" || input.target === "editable") return null;
  if (input.key === "Escape") return "insert";
  const plainEnter =
    input.key === "Enter" && !input.shiftKey && !input.altKey && !input.metaKey && !input.ctrlKey;
  // A focused Done, Send, or Cancel button keeps Enter for itself.
  if (plainEnter && input.target !== "button") return "send";
  return null;
}

const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-command-palette]';

/** Classifies a key event target for {@link recordingKeyOutcome}. */
export function classifyRecordingKeyTarget(
  target: EventTarget | null,
  composer: Element | null,
): RecordingKeyTarget {
  if (!(target instanceof Element)) return "page";
  if (composer?.contains(target)) {
    return target.closest("button") ? "button" : "composer";
  }
  if (target.closest(OVERLAY_SELECTOR)) return "overlay";
  if (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) {
    return "editable";
  }
  return "page";
}
