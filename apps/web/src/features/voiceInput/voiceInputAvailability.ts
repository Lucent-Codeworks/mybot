import type { VoiceInputStatus } from "@mybot/contracts";

/**
 * What the composer mic shows: `hidden`/`unsupported` render nothing,
 * `insecure` renders a disabled mic with {@link INSECURE_VOICE_MESSAGE},
 * `needs-setup` opens the setup prompt, and `ready` records.
 */
export type WebVoiceAvailability = "hidden" | "insecure" | "needs-setup" | "unsupported" | "ready";

export const INSECURE_VOICE_MESSAGE =
  "Voice input needs a secure connection: localhost, Tailscale HTTPS, or the MyBot tunnel.";

export function webVoiceAvailability(input: {
  readonly capability: boolean | undefined;
  readonly secureContext: boolean;
  readonly hasMediaRecorder: boolean;
  readonly status: VoiceInputStatus | null;
}): WebVoiceAvailability {
  if (input.capability !== true) return "hidden";
  const phase = input.status?.phase;
  if (phase === "unsupported" || !input.hasMediaRecorder) return "unsupported";
  if (!input.secureContext) return "insecure";
  if (phase === "not-installed" || phase === "failed") return "needs-setup";
  // A first download has no model to transcribe with yet; the setup prompt shows its progress.
  if (phase === "downloading" && input.status?.model === null) return "needs-setup";
  return "ready";
}
