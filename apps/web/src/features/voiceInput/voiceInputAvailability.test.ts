import type { VoiceInputStatus } from "@mybot/contracts";
import { describe, expect, it } from "vite-plus/test";

import { webVoiceAvailability } from "./voiceInputAvailability";

function status(
  phase: VoiceInputStatus["phase"],
  model: VoiceInputStatus["model"] = null,
): VoiceInputStatus {
  return {
    phase,
    model,
    pendingModel: null,
    downloadedBytes: 0,
    totalBytes: null,
    message: null,
  };
}

const base = { capability: true, secureContext: true, hasMediaRecorder: true, status: null };

describe("webVoiceAvailability", () => {
  it("hides the mic when the server does not advertise voice input", () => {
    expect(webVoiceAvailability({ ...base, capability: undefined })).toBe("hidden");
    expect(webVoiceAvailability({ ...base, capability: false })).toBe("hidden");
  });

  it("explains that an insecure page cannot use the microphone", () => {
    expect(
      webVoiceAvailability({ ...base, secureContext: false, status: status("ready", "base") }),
    ).toBe("insecure");
  });

  it("routes to setup when no speech model is installed", () => {
    expect(webVoiceAvailability({ ...base, status: status("not-installed") })).toBe("needs-setup");
    expect(webVoiceAvailability({ ...base, status: status("failed") })).toBe("needs-setup");
    expect(webVoiceAvailability({ ...base, status: status("downloading") })).toBe("needs-setup");
  });

  it("is ready with an installed model, including while another one downloads", () => {
    expect(webVoiceAvailability({ ...base, status: status("ready", "base") })).toBe("ready");
    expect(webVoiceAvailability({ ...base, status: status("downloading", "base") })).toBe("ready");
  });

  it("is unsupported when the server platform or the browser cannot do it", () => {
    expect(webVoiceAvailability({ ...base, status: status("unsupported") })).toBe("unsupported");
    expect(webVoiceAvailability({ ...base, hasMediaRecorder: false })).toBe("unsupported");
  });
});
