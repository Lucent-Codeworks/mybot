import { describe, expect, it } from "vite-plus/test";

import { VOICE_UPLOAD_MAX_BYTES } from "@mybot/contracts";

import { encodeWav16kMono, fitWavToUploadLimit, VOICE_SAMPLE_RATE } from "./wav.ts";

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

describe("encodeWav16kMono", () => {
  it("writes the canonical 16 kHz mono PCM16 header", () => {
    const wav = encodeWav16kMono(new Float32Array(VOICE_SAMPLE_RATE));
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(wav.length).toBe(44 + 32_000);
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 32_000);
    expect(ascii(wav, 8, 12)).toBe("WAVE");
    expect(ascii(wav, 12, 16)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(wav, 36, 40)).toBe("data");
    expect(view.getUint32(40, true)).toBe(32_000);
  });

  it("clamps samples to [-1, 1] as little-endian PCM16", () => {
    const wav = encodeWav16kMono(new Float32Array([1.5, -1, 0, -2]));
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(view.getInt16(44, true)).toBe(32_767);
    expect(view.getInt16(46, true)).toBe(-32_768);
    expect(view.getInt16(48, true)).toBe(0);
    expect(view.getInt16(50, true)).toBe(-32_768);
  });
});

describe("fitWavToUploadLimit", () => {
  it("keeps a recording within five minutes unchanged", () => {
    const wav = encodeWav16kMono(new Float32Array(VOICE_SAMPLE_RATE));
    expect(fitWavToUploadLimit(wav)).toBe(wav);
  });

  it("cuts a recording that ran past five minutes and fixes its header", () => {
    // Five minutes and half a second, as when capture outlives the limit timer.
    const wav = encodeWav16kMono(new Float32Array(VOICE_SAMPLE_RATE * 300 + VOICE_SAMPLE_RATE / 2));
    const fitted = fitWavToUploadLimit(wav);
    const view = new DataView(fitted.buffer, fitted.byteOffset, fitted.byteLength);

    expect(fitted.length).toBe(VOICE_UPLOAD_MAX_BYTES);
    expect(view.getUint32(4, true)).toBe(VOICE_UPLOAD_MAX_BYTES - 8);
    expect(view.getUint32(40, true)).toBe(VOICE_UPLOAD_MAX_BYTES - 44);
    expect(fitted.subarray(0, 4)).toEqual(wav.subarray(0, 4));
    expect(fitted.subarray(44, 64)).toEqual(wav.subarray(44, 64));
  });

  it("leaves a file without the canonical header for the server to reject", () => {
    const bytes = new Uint8Array(VOICE_UPLOAD_MAX_BYTES + 10);
    expect(fitWavToUploadLimit(bytes)).toBe(bytes);
  });
});
