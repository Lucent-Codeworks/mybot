import { serverVoiceAvailability } from "@mybot/client-runtime/voice-input";
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
  const server = serverVoiceAvailability(input);
  if (server === "hidden") return "hidden";
  if (server === "unsupported" || !input.hasMediaRecorder) return "unsupported";
  if (!input.secureContext) return "insecure";
  return server;
}
