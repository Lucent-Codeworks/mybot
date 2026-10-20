import { describe, expect, it } from "vite-plus/test";

import { encodeWav16kMono, VOICE_SAMPLE_RATE } from "./wav.ts";

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
