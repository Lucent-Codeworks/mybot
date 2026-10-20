import * as Schema from "effect/Schema";

export const VoiceModelId = Schema.Literals(["tiny", "base", "small", "large-v3-turbo"]);
export type VoiceModelId = typeof VoiceModelId.Type;

export const DEFAULT_VOICE_MODEL: VoiceModelId = "base";

/** RIFF WAV header (44 B) plus five minutes of 16 kHz mono PCM16 (32,000 B/s). */
export const VOICE_UPLOAD_MAX_BYTES = 9_600_044;
export const VOICE_UPLOAD_URL_TTL_MS = 10 * 60_000;

/** Download sizes in bytes; large-v3-turbo is the q5_0 build. */
export const VOICE_MODEL_SIZES: Record<VoiceModelId, number> = {
  tiny: 77_691_713,
  base: 147_951_465,
  small: 487_601_967,
  "large-v3-turbo": 574_041_195,
};

export const VoiceInputStatus = Schema.Struct({
  phase: Schema.Literals(["unsupported", "not-installed", "downloading", "ready", "failed"]),
  /** Installed model, if any. */
  model: Schema.NullOr(VoiceModelId),
  /** Model being downloaded, or whose download failed. */
  pendingModel: Schema.NullOr(VoiceModelId),
  downloadedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalBytes: Schema.NullOr(Schema.Int),
  /** User-facing failure text. */
  message: Schema.NullOr(Schema.String),
});
export type VoiceInputStatus = typeof VoiceInputStatus.Type;

export const VoiceInstallInput = Schema.Struct({ model: VoiceModelId });
export type VoiceInstallInput = typeof VoiceInstallInput.Type;

export const VoiceCreateUploadUrlInput = Schema.Struct({ sizeBytes: Schema.Int });
export type VoiceCreateUploadUrlInput = typeof VoiceCreateUploadUrlInput.Type;

export const VoiceCreateUploadUrlResult = Schema.Struct({
  uploadId: Schema.String,
  relativeUrl: Schema.String,
  expiresAt: Schema.Number,
});
export type VoiceCreateUploadUrlResult = typeof VoiceCreateUploadUrlResult.Type;

export const VoiceTranscribeInput = Schema.Struct({ uploadId: Schema.String });
export type VoiceTranscribeInput = typeof VoiceTranscribeInput.Type;

export const VoiceTranscribeResult = Schema.Struct({ text: Schema.String });
export type VoiceTranscribeResult = typeof VoiceTranscribeResult.Type;

export const VoiceTranscriptionCancelInput = Schema.Struct({ uploadId: Schema.String });
export type VoiceTranscriptionCancelInput = typeof VoiceTranscriptionCancelInput.Type;

export class VoiceInputError extends Schema.TaggedError<VoiceInputError>()("VoiceInputError", {
  reason: Schema.Literals([
    "unsupported",
    "not-installed",
    "download",
    "checksum",
    "unpack",
    "save",
    "timeout",
    "upload-missing",
    "transcription-failed",
    "cancelled",
    "busy-install",
  ]),
  detail: Schema.String,
}) {}
