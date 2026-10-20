import { describe, expect, it, vi } from "vite-plus/test";

import {
  createServerVoiceTranscriber,
  type ServerTranscriberDependencies,
} from "./serverTranscriber.ts";
import { VoiceTranscriptionError } from "./transcription.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const WAV = new Uint8Array(44 + 64);

function createDependencies(overrides: Partial<ServerTranscriberDependencies> = {}) {
  const calls: string[] = [];
  const dependencies: ServerTranscriberDependencies = {
    locale: () => "en-US",
    readWav: async (uri) => {
      calls.push(`readWav:${uri}`);
      return WAV;
    },
    createUploadUrl: async (sizeBytes) => {
      calls.push(`createUploadUrl:${sizeBytes}`);
      return { uploadId: "upload-1", relativeUrl: "/api/voice/upload/token" };
    },
    resolveUrl: (relativeUrl) => {
      calls.push(`resolveUrl:${relativeUrl}`);
      return `https://mybot.test${relativeUrl}`;
    },
    post: async (url, body) => {
      calls.push(`post:${url}:${body.length}`);
    },
    transcribe: async (uploadId) => {
      calls.push(`transcribe:${uploadId}`);
      return "hello there";
    },
    cancel: async (uploadId) => {
      calls.push(`cancel:${uploadId}`);
    },
    ...overrides,
  };
  return { dependencies, calls };
}

async function transcribeWith(dependencies: ServerTranscriberDependencies, signal: AbortSignal) {
  const prepared = await createServerVoiceTranscriber(dependencies).prepare({ signal });
  return prepared.transcribe("blob:recording", { signal });
}

describe("createServerVoiceTranscriber", () => {
  it("uploads the recording, then transcribes it on the server", async () => {
    const { dependencies, calls } = createDependencies();
    const prepared = await createServerVoiceTranscriber(dependencies).prepare({
      signal: new AbortController().signal,
    });

    expect(prepared.locale).toBe("en-US");
    await expect(
      prepared.transcribe("blob:recording", { signal: new AbortController().signal }),
    ).resolves.toBe("hello there");
    expect(calls).toEqual([
      "readWav:blob:recording",
      `createUploadUrl:${WAV.length}`,
      "resolveUrl:/api/voice/upload/token",
      `post:https://mybot.test/api/voice/upload/token:${WAV.length}`,
      "transcribe:upload-1",
    ]);
  });

  it("cancels the server job on abort and settles only after transcribe settles", async () => {
    const transcription = deferred<string>();
    const transcribeEntered = deferred<void>();
    const cancel = vi.fn(async () => {
      transcription.reject({
        _tag: "VoiceInputError",
        reason: "cancelled",
        detail: "Transcription was cancelled.",
      });
    });
    const { dependencies } = createDependencies({
      transcribe: () => {
        transcribeEntered.resolve(undefined);
        return transcription.promise;
      },
      cancel,
    });
    const abortController = new AbortController();
    const transcribing = transcribeWith(dependencies, abortController.signal);
    await transcribeEntered.promise;

    abortController.abort();

    await expect(transcribing).rejects.toMatchObject({
      name: "VoiceTranscriptionError",
      code: "cancelled",
    });
    expect(cancel).toHaveBeenCalledWith("upload-1");
  });

  it("does not settle a cancelled transcription while the server is still working", async () => {
    const transcription = deferred<string>();
    const transcribeEntered = deferred<void>();
    const { dependencies } = createDependencies({
      transcribe: () => {
        transcribeEntered.resolve(undefined);
        return transcription.promise;
      },
    });
    const abortController = new AbortController();
    let settled = false;
    const transcribing = transcribeWith(dependencies, abortController.signal).finally(() => {
      settled = true;
    });
    await transcribeEntered.promise;
    abortController.abort();
    await Promise.resolve();
    expect(settled).toBe(false);

    transcription.resolve("late text");
    await expect(transcribing).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects unavailable when the MyBot server is not connected", async () => {
    const post = vi.fn(async () => undefined);
    const { dependencies } = createDependencies({ resolveUrl: () => null, post });

    const error = await transcribeWith(dependencies, new AbortController().signal).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({
      code: "unavailable",
      message: "The MyBot server is not connected.",
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("reports a server without a speech model as unavailable with its detail", async () => {
    const { dependencies } = createDependencies({
      transcribe: async () => {
        throw {
          _tag: "VoiceInputError",
          reason: "not-installed",
          detail: "Voice input is not set up on this MyBot server.",
        };
      },
    });

    await expect(transcribeWith(dependencies, new AbortController().signal)).rejects.toMatchObject({
      code: "unavailable",
      message: "Voice input is not set up on this MyBot server.",
    });
  });
});
