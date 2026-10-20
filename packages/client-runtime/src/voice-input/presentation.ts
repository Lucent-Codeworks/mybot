import { VOICE_MODEL_SIZES, type VoiceInputStatus, type VoiceModelId } from "@mybot/contracts";

/** Copy shared by every client's first-use prompt and settings. */
export const VOICE_SETUP_TITLE = "Set up voice input";
export const VOICE_SETUP_MESSAGE =
  "Voice input needs a speech model on your MyBot server (about 150 MB). Download it?";
export const VOICE_OWNER_NOTICE = "The MyBot server owner needs to turn on voice input.";

/**
 * Whether a MyBot server can transcribe: `hidden` when it does not advertise
 * voice input, `needs-setup` while it has no model, and `ready` otherwise,
 * including while its status is still unknown.
 */
export type ServerVoiceAvailability = "hidden" | "unsupported" | "needs-setup" | "ready";

export function serverVoiceAvailability(input: {
  readonly capability: boolean | undefined;
  readonly status: VoiceInputStatus | null;
}): ServerVoiceAvailability {
  if (input.capability !== true) return "hidden";
  const phase = input.status?.phase;
  if (phase === "unsupported") return "unsupported";
  if (phase === "not-installed" || phase === "failed") return "needs-setup";
  // A first download has no model to transcribe with yet; the setup prompt shows its progress.
  if (phase === "downloading" && input.status?.model === null) return "needs-setup";
  return "ready";
}

const MODEL_NAMES: Readonly<Record<VoiceModelId, string>> = {
  tiny: "Tiny",
  base: "Base",
  small: "Small",
  "large-v3-turbo": "Large turbo",
};

const MODEL_DESCRIPTIONS: Readonly<Record<VoiceModelId, string>> = {
  tiny: "fastest",
  base: "recommended",
  small: "more accurate",
  "large-v3-turbo": "most accurate",
};

export function voiceModelName(model: VoiceModelId): string {
  return MODEL_NAMES[model];
}

/** Whole-number percent of the active download, or null while the total is unknown. */
export function voiceDownloadPercent(status: VoiceInputStatus): number | null {
  if (status.phase !== "downloading" || status.totalBytes === null || status.totalBytes <= 0) {
    return null;
  }
  return Math.min(100, Math.floor((status.downloadedBytes / status.totalBytes) * 100));
}

/** One line for a server's voice state. A download can run while an older model stays installed. */
export function voiceStatusLabel(status: VoiceInputStatus): string {
  switch (status.phase) {
    case "unsupported":
      return "Not available on this MyBot server's platform";
    case "not-installed":
      return "Off";
    case "ready":
      return status.model ? `Ready · ${MODEL_NAMES[status.model]}` : "Ready";
    case "failed":
      return status.message ?? "Voice input setup failed";
    case "downloading": {
      const percent = voiceDownloadPercent(status);
      const progress = status.pendingModel
        ? `${MODEL_NAMES[status.pendingModel]}…${percent === null ? "" : ` ${percent}%`}`
        : `…${percent === null ? "" : ` ${percent}%`}`;
      return status.model
        ? `Ready · ${MODEL_NAMES[status.model]} — downloading ${progress}`
        : `Downloading ${progress}`;
    }
  }
}

export function voiceModelChoices(): ReadonlyArray<{
  id: VoiceModelId;
  label: string;
  sizeLabel: string;
}> {
  return (Object.keys(MODEL_NAMES) as VoiceModelId[]).map((id) => ({
    id,
    label: `${MODEL_NAMES[id]} — ${MODEL_DESCRIPTIONS[id]}`,
    sizeLabel: `${Math.round(VOICE_MODEL_SIZES[id] / 1_000_000)} MB`,
  }));
}

export type VoiceSetupStep =
  | "ask"
  | "starting"
  | "downloading"
  | "failed"
  | "unsupported"
  | "close";

/**
 * What the first-use dialog shows. `requested` only bridges the gap between
 * tapping Download and the first status update; the live phase wins after that,
 * so a failed download shows its message with Download available again.
 */
export function voiceSetupStep(
  status: VoiceInputStatus | null,
  requested: boolean,
): VoiceSetupStep {
  if (status?.phase === "ready" && status.model !== null) return "close";
  if (status?.phase === "downloading") return "downloading";
  if (status?.phase === "failed") return "failed";
  if (status?.phase === "unsupported") return "unsupported";
  return requested ? "starting" : "ask";
}
