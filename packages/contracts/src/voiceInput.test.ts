import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { VOICE_MODEL_SIZES, VOICE_UPLOAD_MAX_BYTES, VoiceInputStatus } from "./voiceInput.ts";

const decodeStatus = Schema.decodeUnknownSync(VoiceInputStatus);

describe("voice input contracts", () => {
  it("decodes a downloading status", () => {
    const status = {
      phase: "downloading",
      model: null,
      pendingModel: "base",
      downloadedBytes: 10,
      totalBytes: 147951465,
      message: null,
    };
    expect(decodeStatus(status)).toEqual(status);
  });

  it("rejects an unknown phase", () => {
    expect(() =>
      decodeStatus({
        phase: "installing",
        model: null,
        pendingModel: null,
        downloadedBytes: 0,
        totalBytes: null,
        message: null,
      }),
    ).toThrow();
  });

  it("sizes the upload cap for five minutes of 16 kHz mono PCM16 plus a WAV header", () => {
    expect(VOICE_UPLOAD_MAX_BYTES).toBe(44 + 300 * 16000 * 2);
    expect(VOICE_MODEL_SIZES.base).toBe(147_951_465);
  });
});
