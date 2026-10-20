import {
  VOICE_RECORDING_LIMIT_SECONDS,
  VOICE_SAMPLE_RATE,
  encodeWav16kMono,
  throwIfVoiceTranscriptionAborted,
} from "@mybot/client-runtime/voice-input";

/**
 * Decodes a MediaRecorder Blob (WebM/Opus, MP4/AAC, Ogg) and resamples it to
 * the 16 kHz mono WAV MyBot servers transcribe. Never longer than the 5-minute
 * limit, so a recorder that overshoots its timer still fits the upload cap.
 */
export async function decodeToWav(blob: Blob, signal: AbortSignal): Promise<Uint8Array> {
  throwIfVoiceTranscriptionAborted(signal);
  const encoded = await blob.arrayBuffer();
  throwIfVoiceTranscriptionAborted(signal);
  // Decoding needs a context but not a running audio device, so use an offline one.
  const decoded = await new OfflineAudioContext(1, 1, VOICE_SAMPLE_RATE).decodeAudioData(encoded);
  throwIfVoiceTranscriptionAborted(signal);

  const frames = Math.max(
    1,
    Math.min(
      Math.ceil(decoded.duration * VOICE_SAMPLE_RATE),
      VOICE_RECORDING_LIMIT_SECONDS * VOICE_SAMPLE_RATE,
    ),
  );
  const context = new OfflineAudioContext(1, frames, VOICE_SAMPLE_RATE);
  const source = context.createBufferSource();
  source.buffer = decoded;
  source.connect(context.destination);
  source.start(0);
  const rendered = await context.startRendering();
  throwIfVoiceTranscriptionAborted(signal);
  return encodeWav16kMono(rendered.getChannelData(0));
}
