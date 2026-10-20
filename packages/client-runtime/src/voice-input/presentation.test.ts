import type { VoiceInputStatus } from "@mybot/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  serverVoiceAvailability,
  voiceDownloadPercent,
  voiceModelChoices,
  voiceSetupModel,
  voiceSetupStep,
  voiceStatusLabel,
} from "./presentation.ts";

const status = (patch: Partial<VoiceInputStatus>): VoiceInputStatus => ({
  phase: "not-installed",
  model: null,
  pendingModel: null,
  downloadedBytes: 0,
  totalBytes: null,
  message: null,
  ...patch,
});

describe("voiceStatusLabel", () => {
  it("shows real download progress", () => {
    expect(
      voiceStatusLabel(
        status({
          phase: "downloading",
          pendingModel: "base",
          downloadedBytes: 50,
          totalBytes: 100,
        }),
      ),
    ).toBe("Downloading Base… 50%");
  });

  it("omits the percentage until the total is known", () => {
    expect(voiceStatusLabel(status({ phase: "downloading", pendingModel: "base" }))).toBe(
      "Downloading Base…",
    );
  });

  it("shows both the installed model and the one being downloaded", () => {
    expect(
      voiceStatusLabel(
        status({
          phase: "downloading",
          model: "base",
          pendingModel: "small",
          downloadedBytes: 40,
          totalBytes: 100,
        }),
      ),
    ).toBe("Ready · Base — downloading Small… 40%");
  });

  it("labels ready, off, failed and unsupported servers", () => {
    expect(voiceStatusLabel(status({ phase: "ready", model: "base" }))).toBe("Ready · Base");
    expect(voiceStatusLabel(status({ phase: "not-installed" }))).toBe("Off");
    expect(voiceStatusLabel(status({ phase: "failed", message: "Checksum mismatch" }))).toBe(
      "Checksum mismatch",
    );
    expect(
      voiceStatusLabel(status({ phase: "failed", model: "tiny", message: "Checksum mismatch" })),
    ).toBe("Ready · Tiny — Checksum mismatch");
    expect(voiceStatusLabel(status({ phase: "unsupported" }))).toBe(
      "Not available on this MyBot server's platform",
    );
  });
});

describe("voiceDownloadPercent", () => {
  it("is null when idle or the total is unknown, and clamps to 100", () => {
    expect(voiceDownloadPercent(status({ phase: "ready", model: "base" }))).toBeNull();
    expect(voiceDownloadPercent(status({ phase: "downloading", downloadedBytes: 5 }))).toBeNull();
    expect(
      voiceDownloadPercent(status({ phase: "downloading", downloadedBytes: 120, totalBytes: 100 })),
    ).toBe(100);
  });
});

describe("voiceModelChoices", () => {
  it("lists the four models with sizes, base recommended", () => {
    const choices = voiceModelChoices();
    expect(choices.map((choice) => choice.label)).toEqual([
      "Tiny — fastest",
      "Base — recommended",
      "Small — more accurate",
      "Large turbo — most accurate",
    ]);
    expect(choices[1]).toEqual({
      id: "base",
      label: "Base — recommended",
      sizeLabel: "148 MB",
    });
  });
});

describe("voiceSetupStep", () => {
  it("walks not-installed, downloading, failed, retry, ready", () => {
    expect(voiceSetupStep(status({}), false)).toBe("ask");
    expect(voiceSetupStep(status({}), true)).toBe("starting");
    expect(voiceSetupStep(status({ phase: "downloading", pendingModel: "base" }), true)).toBe(
      "downloading",
    );
    // Failure wins over the stale request, so Download is offered again.
    expect(voiceSetupStep(status({ phase: "failed", message: "Network error" }), true)).toBe(
      "failed",
    );
    expect(voiceSetupStep(status({ phase: "downloading", pendingModel: "base" }), true)).toBe(
      "downloading",
    );
    expect(voiceSetupStep(status({ phase: "ready", model: "base" }), true)).toBe("close");
  });

  it("closes when a failed switch left the installed model working", () => {
    expect(
      voiceSetupStep(status({ phase: "failed", model: "tiny", pendingModel: "small" }), false),
    ).toBe("close");
  });

  it("treats an unknown status as not yet started", () => {
    expect(voiceSetupStep(null, false)).toBe("ask");
    expect(voiceSetupStep(status({ phase: "unsupported" }), false)).toBe("unsupported");
  });
});

describe("serverVoiceAvailability", () => {
  it("hides voice input on servers that do not advertise it", () => {
    expect(serverVoiceAvailability({ capability: undefined, status: null })).toBe("hidden");
    expect(serverVoiceAvailability({ capability: false, status: null })).toBe("hidden");
  });

  it("stays ready after a failed switch, since the old model still transcribes", () => {
    expect(
      serverVoiceAvailability({
        capability: true,
        status: status({ phase: "failed", model: "tiny", pendingModel: "small" }),
      }),
    ).toBe("ready");
  });

  it("needs setup until a model is installed", () => {
    for (const phase of ["not-installed", "failed", "downloading"] as const) {
      expect(serverVoiceAvailability({ capability: true, status: status({ phase }) })).toBe(
        "needs-setup",
      );
    }
  });

  it("is ready with a model, including while another one downloads", () => {
    expect(
      serverVoiceAvailability({
        capability: true,
        status: status({ phase: "ready", model: "base" }),
      }),
    ).toBe("ready");
    expect(
      serverVoiceAvailability({
        capability: true,
        status: status({ phase: "downloading", model: "base", pendingModel: "small" }),
      }),
    ).toBe("ready");
  });

  it("reports an unsupported server platform", () => {
    expect(
      serverVoiceAvailability({ capability: true, status: status({ phase: "unsupported" }) }),
    ).toBe("unsupported");
  });
});

describe("voiceSetupModel", () => {
  it("retries the model whose download failed, else the default", () => {
    expect(voiceSetupModel(status({ phase: "failed", pendingModel: "small" }))).toBe("small");
    expect(voiceSetupModel(status({ phase: "failed" }))).toBe("base");
    expect(voiceSetupModel(null)).toBe("base");
  });
});
