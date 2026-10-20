import { VOICE_UPLOAD_MAX_BYTES } from "@mybot/contracts";

/** Sample rate of the wire format MyBot servers accept for transcription. */
export const VOICE_SAMPLE_RATE = 16_000;

const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

function readAscii(view: DataView, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(view.getUint8(offset + index));
  }
  return text;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/**
 * Encodes mono samples already at {@link VOICE_SAMPLE_RATE} as a RIFF WAV with
 * the canonical 44-byte header and 16-bit little-endian PCM. Samples are
 * clamped to [-1, 1].
 */
export function encodeWav16kMono(samples: Float32Array): Uint8Array {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, VOICE_SAMPLE_RATE, true);
  view.setUint32(28, VOICE_SAMPLE_RATE * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(
      HEADER_BYTES + index * BYTES_PER_SAMPLE,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }
  return bytes;
}

/**
 * Cuts a canonical 44-byte-header WAV to the five minutes a MyBot server
 * accepts, fixing its RIFF and data sizes. A recorder's limit timer can stop
 * capture a little late; anything else is returned unchanged.
 */
export function fitWavToUploadLimit(bytes: Uint8Array): Uint8Array {
  if (bytes.length <= VOICE_UPLOAD_MAX_BYTES) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const canonical =
    readAscii(view, 0, 4) === "RIFF" &&
    readAscii(view, 8, 4) === "WAVE" &&
    readAscii(view, 12, 4) === "fmt " &&
    view.getUint32(16, true) === 16 &&
    readAscii(view, 36, 4) === "data";
  if (!canonical) return bytes;
  // Whole samples only; the header and limit are both even.
  const fitted = bytes.slice(0, VOICE_UPLOAD_MAX_BYTES);
  const fittedView = new DataView(fitted.buffer);
  fittedView.setUint32(4, VOICE_UPLOAD_MAX_BYTES - 8, true);
  fittedView.setUint32(40, VOICE_UPLOAD_MAX_BYTES - HEADER_BYTES, true);
  return fitted;
}
