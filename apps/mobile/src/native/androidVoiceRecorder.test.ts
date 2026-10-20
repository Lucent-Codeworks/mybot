import { describe, expect, it, vi } from "vite-plus/test";
import type { VoiceRecorderStatus } from "@mybot/client-runtime/voice-input";

import {
  createAndroidVoiceRecorder,
  normalizeRecordingUri,
  pcm16PeakDecibels,
  type AudioStudioNativeModule,
} from "./androidVoiceRecorder";

function pcm16Base64(samples: ReadonlyArray<number>): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return btoa(String.fromCharCode(...bytes));
}

function createNative() {
  const listeners = new Map<string, (event: never) => void>();
  const start = Promise.withResolvers<{ fileUri: string; mimeType: string }>();
  const native = {
    prepareRecording: vi.fn(async () => true),
    startRecording: vi.fn(() => start.promise),
    stopRecording: vi.fn(async () => ({ fileUri: "file:/data/voice.wav" })),
    addListener: vi.fn((name: string, listener: (event: never) => void) => {
      listeners.set(name, listener);
      return { remove: () => listeners.delete(name) };
    }),
  };
  const emit = (name: string, event: unknown) => listeners.get(name)?.(event as never);
  return {
    native: native as unknown as AudioStudioNativeModule,
    mocks: native,
    start,
    emit,
    listeners,
  };
}

async function startRecording() {
  const fake = createNative();
  const statuses: VoiceRecorderStatus[] = [];
  const recorder = createAndroidVoiceRecorder({
    loadNativeModule: () => fake.native,
    onStatus: (status) => statuses.push(status),
  });
  await recorder.prepareToRecordAsync();
  recorder.record({ forDuration: 300 });
  return { ...fake, recorder, statuses };
}

describe("android voice recorder", () => {
  it("records 16 kHz mono PCM16 WAV up to the requested limit", async () => {
    const { mocks } = await startRecording();
    expect(mocks.startRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        sampleRate: 16_000,
        channels: 1,
        encoding: "pcm_16bit",
        maxDurationMs: 300_000,
        autoStopOnMaxDuration: false,
      }),
    );
  });

  it("waits for the native start before stopping, then reports the file", async () => {
    const { recorder, mocks, start } = await startRecording();
    const stopping = recorder.stop();
    expect(mocks.stopRecording).not.toHaveBeenCalled();
    start.resolve({ fileUri: "file:/data/voice.wav", mimeType: "audio/wav" });
    await stopping;
    expect(mocks.stopRecording).toHaveBeenCalledTimes(1);
    expect(recorder.uri).toBe("file:///data/voice.wav");
  });

  it("stops and reports a finished recording at the limit", async () => {
    const fake = createNative();
    const finished = Promise.withResolvers<VoiceRecorderStatus>();
    const recorder = createAndroidVoiceRecorder({
      loadNativeModule: () => fake.native,
      onStatus: finished.resolve,
    });
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: 300 });
    fake.emit("MaxDurationReached", {});
    fake.start.resolve({ fileUri: "file:/data/voice.wav", mimeType: "audio/wav" });
    expect(await finished.promise).toEqual({
      isFinished: true,
      hasError: false,
      error: null,
      url: "file:///data/voice.wav",
    });
    expect(fake.mocks.stopRecording).toHaveBeenCalledTimes(1);
  });

  it("reports a paused interruption as an error", async () => {
    const { emit, statuses } = await startRecording();
    emit("onRecordingInterrupted", { reason: "audioFocusGain", isPaused: false });
    emit("onRecordingInterrupted", { reason: "audioFocusLoss", isPaused: true });
    expect(statuses).toEqual([
      expect.objectContaining({
        isFinished: false,
        hasError: true,
        error: "Voice recording was interrupted.",
      }),
    ]);
  });

  it("ignores the limit after the recording was stopped", async () => {
    const { recorder, start, emit, statuses, mocks } = await startRecording();
    start.resolve({ fileUri: "file:/data/voice.wav", mimeType: "audio/wav" });
    await recorder.stop();
    emit("MaxDurationReached", {});
    expect(statuses).toEqual([]);
    expect(mocks.stopRecording).toHaveBeenCalledTimes(1);
  });
});

describe("recording helpers", () => {
  it("normalizes Android's single-slash file URIs", () => {
    expect(normalizeRecordingUri("file:/data/user/0/voice.wav")).toBe(
      "file:///data/user/0/voice.wav",
    );
    expect(normalizeRecordingUri("file:///data/voice.wav")).toBe("file:///data/voice.wav");
  });

  it("measures the peak of a PCM16 chunk in dBFS", () => {
    expect(pcm16PeakDecibels(pcm16Base64([0, 0]))).toBe(-160);
    expect(pcm16PeakDecibels(pcm16Base64([100, -32_768]))).toBe(0);
    expect(pcm16PeakDecibels(pcm16Base64([16_384]))).toBeCloseTo(-6.02, 2);
    expect(pcm16PeakDecibels("")).toBeUndefined();
  });
});
