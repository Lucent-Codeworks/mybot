import {
  VOICE_RECORDING_LIMIT_SECONDS,
  VOICE_SAMPLE_RATE,
  type VoiceRecorder,
  type VoiceRecorderStatus,
} from "@mybot/client-runtime/voice-input";
import type {
  AudioRecording,
  RecordingConfig,
  RecordingInterruptionEvent,
  StartRecordingResult,
} from "@siteed/audio-studio";

type Subscription = { remove(): void };

/** The part of audio-studio's native `AudioStudio` module the recorder uses. */
export interface AudioStudioNativeModule {
  prepareRecording(options: RecordingConfig): Promise<boolean>;
  startRecording(options: RecordingConfig): Promise<StartRecordingResult>;
  stopRecording(): Promise<AudioRecording | null>;
  addListener(
    eventName: "AudioData",
    listener: (event: { encoded?: string }) => void,
  ): Subscription;
  addListener(eventName: "MaxDurationReached", listener: () => void): Subscription;
  addListener(
    eventName: "onRecordingInterrupted",
    listener: (event: RecordingInterruptionEvent) => void,
  ): Subscription;
}

/** What the provider samples for the waveform and elapsed time, matching expo-audio's state. */
export type AndroidRecorderState = {
  readonly isRecording: boolean;
  readonly durationMillis: number;
  readonly metering: number | undefined;
};

export interface AndroidVoiceRecorder extends VoiceRecorder {
  getStatus(): AndroidRecorderState | null;
  release(): void;
}

// The server's wire format: PCM16 mono WAV at 16 kHz. The native recorder
// opens the microphone at exactly this rate or fails; it never resamples.
const RECORDING_OPTIONS = {
  sampleRate: VOICE_SAMPLE_RATE,
  channels: 1,
  encoding: "pcm_16bit",
  interval: 100,
  output: { primary: { enabled: true, format: "wav" }, compressed: { enabled: false } },
  maxDurationMs: VOICE_RECORDING_LIMIT_SECONDS * 1_000,
  autoStopOnMaxDuration: false,
  autoResumeAfterInterruption: false,
  keepAwake: false,
  showNotification: false,
  enableProcessing: false,
  android: { audioFocusStrategy: "interactive" },
} satisfies RecordingConfig;

const INTERRUPTED_MESSAGE = "Voice recording was interrupted.";

/** Android reports `file:/data/…`; expo-file-system and fetch expect `file:///data/…`. */
export function normalizeRecordingUri(uri: string): string {
  return uri.replace(/^file:\/(?!\/)/, "file:///");
}

/** Peak level in dBFS of a base64 chunk of little-endian PCM16, or undefined when empty. */
export function pcm16PeakDecibels(base64: string): number | undefined {
  const binary = atob(base64);
  if (binary.length < 2) return undefined;
  let peak = 0;
  for (let index = 0; index + 1 < binary.length; index += 2) {
    const unsigned = binary.charCodeAt(index) | (binary.charCodeAt(index + 1) << 8);
    const sample = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
    peak = Math.max(peak, Math.abs(sample));
  }
  return peak === 0 ? -160 : 20 * Math.log10(peak / 32_768);
}

/**
 * Records 16 kHz mono WAV with audio-studio for server transcription on
 * Android. The native module loads on first prepare, and the recording limit
 * finishes like expo-audio's `forDuration`: stopped, then reported finished.
 */
export function createAndroidVoiceRecorder(input: {
  readonly loadNativeModule: () => AudioStudioNativeModule;
  readonly onStatus: (status: VoiceRecorderStatus) => void;
}): AndroidVoiceRecorder {
  let native: AudioStudioNativeModule | null = null;
  let subscriptions: Subscription[] = [];
  let uri: string | null = null;
  let starting: Promise<void> | null = null;
  let recording = false;
  // From `record` until `stop`, including while the native start is pending.
  let active = false;
  let startedAt = 0;
  let metering: number | undefined;

  const stop = async (): Promise<void> => {
    const module = native;
    active = false;
    await starting;
    if (!recording || !module) return;
    recording = false;
    const result = await module.stopRecording();
    if (result?.fileUri) uri = normalizeRecordingUri(result.fileUri);
  };

  const subscribe = (module: AudioStudioNativeModule) => [
    module.addListener("AudioData", (event) => {
      if (active && event.encoded) metering = pcm16PeakDecibels(event.encoded);
    }),
    module.addListener("MaxDurationReached", () => {
      if (!active) return;
      void stop().then(
        () => input.onStatus({ isFinished: true, hasError: false, error: null, url: uri }),
        () => input.onStatus({ isFinished: false, hasError: true, error: null, url: uri }),
      );
    }),
    module.addListener("onRecordingInterrupted", (event) => {
      if (!active || (!event.isPaused && event.reason !== "recordingStopped")) return;
      input.onStatus({ isFinished: false, hasError: true, error: INTERRUPTED_MESSAGE, url: uri });
    }),
  ];

  return {
    get uri() {
      return uri;
    },
    async prepareToRecordAsync() {
      if (!native) {
        native = input.loadNativeModule();
        subscriptions = subscribe(native);
      }
      uri = null;
      metering = undefined;
      await native.prepareRecording(RECORDING_OPTIONS);
    },
    record(options) {
      const module = native;
      if (!module) throw new Error("Voice recorder is not prepared.");
      startedAt = Date.now();
      active = true;
      starting = module
        .startRecording({ ...RECORDING_OPTIONS, maxDurationMs: options.forDuration * 1_000 })
        .then(
          (result) => {
            uri = normalizeRecordingUri(result.fileUri);
            recording = true;
          },
          (error: unknown) => {
            input.onStatus({
              isFinished: false,
              hasError: true,
              error: error instanceof Error ? error.message : INTERRUPTED_MESSAGE,
              url: null,
            });
          },
        )
        .finally(() => {
          starting = null;
        });
    },
    stop,
    getStatus() {
      if (!native) return null;
      return {
        isRecording: active,
        durationMillis: active ? Date.now() - startedAt : 0,
        metering,
      };
    },
    release() {
      for (const subscription of subscriptions) subscription.remove();
      subscriptions = [];
      void stop().catch(() => {});
      native = null;
    },
  };
}
