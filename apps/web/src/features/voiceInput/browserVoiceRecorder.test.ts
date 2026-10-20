import type { VoiceRecorderStatus } from "@mybot/client-runtime/voice-input";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createBrowserVoiceRecorder } from "./browserVoiceRecorder";

class FakeMediaRecorder {
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  ondataavailable: MediaRecorder["ondataavailable"] = null;
  onstop: MediaRecorder["onstop"] = null;
  onerror: MediaRecorder["onerror"] = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    const recorder = this as unknown as MediaRecorder;
    this.ondataavailable?.call(recorder, { data: new Blob(["audio"]) } as BlobEvent);
    this.onstop?.call(recorder, new Event("stop"));
  }
}

function setup(options: { deny?: boolean } = {}) {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const recorders: FakeMediaRecorder[] = [];
  const statuses: VoiceRecorderStatus[] = [];
  const revoked: string[] = [];
  let urls = 0;
  const recorder = createBrowserVoiceRecorder({
    getUserMedia: async () => {
      if (options.deny) throw new DOMException("denied", "NotAllowedError");
      return stream;
    },
    createMediaRecorder: () => {
      const created = new FakeMediaRecorder();
      recorders.push(created);
      return created;
    },
    createObjectURL: () => `blob:recording-${++urls}`,
    revokeObjectURL: (uri) => revoked.push(uri),
    onStatus: (status) => statuses.push(status),
  });
  return { recorder, track, recorders, statuses, revoked };
}

describe("createBrowserVoiceRecorder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the microphone and exposes the recording when stopped", async () => {
    const { recorder, track } = setup();
    await recorder.requestPermission();
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: 300 });

    await recorder.stop();

    expect(recorder.uri).toBe("blob:recording-1");
    expect(track.stop).toHaveBeenCalled();
  });

  it("finishes by itself at the duration limit", async () => {
    const { recorder, track, statuses } = setup();
    await recorder.requestPermission();
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: 300 });

    await vi.advanceTimersByTimeAsync(300_000);

    expect(statuses).toEqual([
      { isFinished: true, hasError: false, error: null, url: "blob:recording-1" },
    ]);
    expect(track.stop).toHaveBeenCalled();
  });

  it("releases the microphone without producing a recording", async () => {
    const { recorder, track, recorders, statuses } = setup();
    await recorder.requestPermission();
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: 300 });

    recorder.release();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(recorders[0]?.state).toBe("inactive");
    expect(recorder.uri).toBeNull();
    expect(statuses).toEqual([]);
    expect(track.stop).toHaveBeenCalled();
  });

  it("closes a microphone that opens after the recorder was released", async () => {
    const track = { stop: vi.fn() };
    let open: (stream: MediaStream) => void = () => {};
    const recorder = createBrowserVoiceRecorder({
      getUserMedia: () =>
        new Promise<MediaStream>((resolve) => {
          open = resolve;
        }),
      createMediaRecorder: () => new FakeMediaRecorder(),
      createObjectURL: () => "blob:unused",
      revokeObjectURL: () => {},
      onStatus: () => {},
    });

    const permission = recorder.requestPermission();
    recorder.release();
    open({ getTracks: () => [track] } as unknown as MediaStream);
    await permission;

    expect(track.stop).toHaveBeenCalled();
  });

  it("reports a denied microphone as a settings fix", async () => {
    const { recorder } = setup({ deny: true });
    await expect(recorder.requestPermission()).resolves.toEqual({
      granted: false,
      canAskAgain: false,
    });
  });

  it("revokes deleted recordings", async () => {
    const { recorder, revoked } = setup();
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: 300 });
    await recorder.stop();

    recorder.deleteRecording("blob:recording-1");

    expect(revoked).toEqual(["blob:recording-1"]);
    expect(recorder.uri).toBeNull();
  });
});
