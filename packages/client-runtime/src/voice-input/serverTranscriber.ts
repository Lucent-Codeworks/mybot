import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "./transcription.ts";

/**
 * What a client supplies to transcribe on its MyBot server. The RPC-backed
 * members (`createUploadUrl`, `transcribe`, `cancel`) reject with the server's
 * error value, such as a squashed `VoiceInputError`; `post` rejects on any
 * non-2xx response.
 */
export type ServerTranscriberDependencies = {
  readonly locale: () => string;
  readonly readWav: (uri: string, signal: AbortSignal) => Promise<Uint8Array>;
  readonly createUploadUrl: (
    sizeBytes: number,
  ) => Promise<{ readonly uploadId: string; readonly relativeUrl: string }>;
  readonly resolveUrl: (relativeUrl: string) => string | null;
  readonly post: (url: string, body: Uint8Array, signal: AbortSignal) => Promise<void>;
  readonly transcribe: (uploadId: string) => Promise<string>;
  readonly cancel: (uploadId: string) => Promise<void>;
};

const FAILED_MESSAGE = "Could not transcribe this recording.";

function cancelledError(): VoiceTranscriptionError {
  return new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.");
}

function serverVoiceError(
  error: unknown,
): { readonly reason: string; readonly detail: string } | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "VoiceInputError" &&
    "reason" in error &&
    typeof error.reason === "string" &&
    "detail" in error &&
    typeof error.detail === "string"
  ) {
    return { reason: error.reason, detail: error.detail };
  }
  return null;
}

function toTranscriptionError(error: unknown): VoiceTranscriptionError {
  if (error instanceof VoiceTranscriptionError) return error;
  const server = serverVoiceError(error);
  if (server?.reason === "not-installed" || server?.reason === "unsupported") {
    return new VoiceTranscriptionError("unavailable", server.detail, { cause: error });
  }
  if (server?.reason === "cancelled") return cancelledError();
  return new VoiceTranscriptionError("transcription-failed", server?.detail ?? FAILED_MESSAGE, {
    cause: error,
  });
}

async function transcribeOnServer(
  dependencies: ServerTranscriberDependencies,
  uri: string,
  signal: AbortSignal,
): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  let uploadId: string;
  let body: Uint8Array;
  let url: string;
  try {
    body = await dependencies.readWav(uri, signal);
    throwIfVoiceTranscriptionAborted(signal);
    const minted = await dependencies.createUploadUrl(body.length);
    uploadId = minted.uploadId;
    const resolved = dependencies.resolveUrl(minted.relativeUrl);
    if (resolved === null) {
      throw new VoiceTranscriptionError("unavailable", "The MyBot server is not connected.");
    }
    url = resolved;
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw toTranscriptionError(error);
  }

  // From here the server may hold the recording, so every exit cancels it unless
  // `transcribe` ran, which deletes it whatever the outcome.
  const cancelUpload = () => dependencies.cancel(uploadId).catch(() => undefined);
  try {
    await dependencies.post(url, body, signal);
  } catch (error) {
    await cancelUpload();
    throwIfVoiceTranscriptionAborted(signal);
    throw toTranscriptionError(error);
  }
  if (signal.aborted) {
    await cancelUpload();
    throw cancelledError();
  }

  let cancelling: Promise<unknown> | null = null;
  const onAbort = () => {
    cancelling = cancelUpload();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    // Settles only once the server has stopped: `cancel` makes it fail `cancelled`.
    const text = await dependencies.transcribe(uploadId);
    throwIfVoiceTranscriptionAborted(signal);
    return text;
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw toTranscriptionError(error);
  } finally {
    signal.removeEventListener("abort", onAbort);
    await cancelling;
  }
}

/** Transcribes recordings on a MyBot server: signed HTTP upload, then the transcribe RPC. */
export function createServerVoiceTranscriber(
  dependencies: ServerTranscriberDependencies,
): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      return {
        locale: dependencies.locale(),
        transcribe: (uri, options) => transcribeOnServer(dependencies, uri, options.signal),
      };
    },
  };
}
