import type { VoiceRecorder, VoiceRecorderStatus } from "@mybot/client-runtime/voice-input";

export interface BrowserVoiceRecorder extends VoiceRecorder {
  /** Opens the microphone; the browser asks for permission the first time. */
  requestPermission(): Promise<{ readonly granted: boolean; readonly canAskAgain: boolean }>;
  /** Stops every microphone track and abandons a recording in progress. */
  release(): void;
  /** Revokes a finished recording's object URL. */
  deleteRecording(uri: string): void;
}

type MediaRecorderLike = Pick<
  MediaRecorder,
  "start" | "stop" | "state" | "mimeType" | "ondataavailable" | "onstop" | "onerror"
>;

export type BrowserVoiceRecorderDependencies = {
  readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly createMediaRecorder: (stream: MediaStream) => MediaRecorderLike;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (uri: string) => void;
  /** Reports a recording that ended on its own: the duration limit, an error, or a lost mic. */
  readonly onStatus: (status: VoiceRecorderStatus) => void;
};

function isPermissionDenied(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "SecurityError")
  );
}

/**
 * Records the microphone with MediaRecorder. `uri` is the object URL of the
 * final Blob once a recording stops. `record({ forDuration })` stops itself at
 * that limit and reports it through `onStatus`.
 */
export function createBrowserVoiceRecorder(
  dependencies: BrowserVoiceRecorderDependencies,
): BrowserVoiceRecorder {
  let stream: MediaStream | null = null;
  let mediaRecorder: MediaRecorderLike | null = null;
  let chunks: Blob[] = [];
  let uri: string | null = null;
  let limitTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping: Promise<void> | null = null;
  // Bumped by release() so a microphone that opens after it is closed again.
  let generation = 0;

  const openStream = async (): Promise<MediaStream | null> => {
    const opened = generation;
    const next = await dependencies.getUserMedia({ audio: true });
    if (opened !== generation) {
      for (const track of next.getTracks()) track.stop();
      return null;
    }
    stream = next;
    return next;
  };

  const stopTracks = () => {
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  };

  const clearLimit = () => {
    if (limitTimer !== null) clearTimeout(limitTimer);
    limitTimer = null;
  };

  const detach = (recorder: MediaRecorderLike) => {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
  };

  /** Stops the active recorder and resolves once its final Blob has a URL. */
  const finish = (recorder: MediaRecorderLike): Promise<void> => {
    if (stopping) return stopping;
    clearLimit();
    stopping = new Promise<void>((resolve) => {
      const onStopped = () => {
        detach(recorder);
        if (mediaRecorder === recorder) mediaRecorder = null;
        uri = dependencies.createObjectURL(
          new Blob(chunks, recorder.mimeType ? { type: recorder.mimeType } : {}),
        );
        chunks = [];
        stopTracks();
        stopping = null;
        resolve();
      };
      recorder.onstop = onStopped;
      if (recorder.state === "inactive") onStopped();
      else recorder.stop();
    });
    return stopping;
  };

  return {
    get uri() {
      return uri;
    },
    async requestPermission() {
      if (stream) return { granted: true, canAskAgain: true };
      try {
        await openStream();
        return { granted: true, canAskAgain: true };
      } catch (error) {
        // A denied site permission can only be changed in the browser's settings.
        if (isPermissionDenied(error)) return { granted: false, canAskAgain: false };
        throw error;
      }
    },
    async prepareToRecordAsync() {
      const active = stream ?? (await openStream());
      if (!active) throw new Error("Voice recording was released.");
      chunks = [];
      uri = null;
      const recorder = dependencies.createMediaRecorder(active);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        clearLimit();
        detach(recorder);
        if (mediaRecorder === recorder) mediaRecorder = null;
        chunks = [];
        stopTracks();
        dependencies.onStatus({
          isFinished: false,
          hasError: true,
          error: "Voice recording was interrupted.",
          url: null,
        });
      };
      mediaRecorder = recorder;
    },
    record({ forDuration }) {
      const recorder = mediaRecorder;
      if (!recorder) return;
      // A recorder that stops without being asked (the mic was unplugged) still
      // hands over what it captured.
      recorder.onstop = () => {
        void finish(recorder).then(() =>
          dependencies.onStatus({ isFinished: true, hasError: false, error: null, url: uri }),
        );
      };
      recorder.start();
      limitTimer = setTimeout(() => {
        limitTimer = null;
        void finish(recorder).then(() =>
          dependencies.onStatus({ isFinished: true, hasError: false, error: null, url: uri }),
        );
      }, forDuration * 1000);
    },
    async stop() {
      const recorder = mediaRecorder;
      if (recorder) await finish(recorder);
      else if (stopping) await stopping;
      stopTracks();
    },
    release() {
      generation += 1;
      clearLimit();
      const recorder = mediaRecorder;
      mediaRecorder = null;
      if (recorder && !stopping) {
        detach(recorder);
        if (recorder.state !== "inactive") recorder.stop();
      }
      chunks = [];
      stopTracks();
    },
    deleteRecording(recordingUri) {
      dependencies.revokeObjectURL(recordingUri);
      if (uri === recordingUri) uri = null;
    },
  };
}

/** The recorder backed by this browser's microphone. */
export function createWindowVoiceRecorder(
  onStatus: BrowserVoiceRecorderDependencies["onStatus"],
): BrowserVoiceRecorder {
  return createBrowserVoiceRecorder({
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createMediaRecorder: (stream) => new MediaRecorder(stream),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (recordingUri) => URL.revokeObjectURL(recordingUri),
    onStatus,
  });
}
