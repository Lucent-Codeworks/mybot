import type { VoiceInputStatus } from "@mybot/contracts";
import { describe, expect, it } from "vite-plus/test";

import { voiceDownloadPercent, voiceModelChoices, voiceStatusLabel } from "./VoiceSettings.logic";

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
