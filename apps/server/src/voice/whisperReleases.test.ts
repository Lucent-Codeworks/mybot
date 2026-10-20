import { describe, expect, it } from "@effect/vitest";

import {
  cleanTranscript,
  pinnedWhisperCli,
  pinnedWhisperModel,
  whisperArgs,
} from "./whisperReleases.ts";

describe("whisperReleases", () => {
  it("pins the whisper-cli executable per platform", () => {
    expect(pinnedWhisperCli("linux", "x64")?.executable).toEqual(["whisper-cli"]);
    expect(pinnedWhisperCli("freebsd", "x64")).toBeNull();
  });

  it("pins the model size for the default model", () => {
    expect(pinnedWhisperModel("base").sizeBytes).toBe(147_951_465);
  });

  it("drops non-speech markers and joins lines", () => {
    expect(cleanTranscript(" [BLANK_AUDIO]\n")).toBe("");
    expect(cleanTranscript("(silence)")).toBe("");
    expect(cleanTranscript(" Hello there.\n How are you?\n")).toBe("Hello there. How are you?");
    expect(cleanTranscript("[MUSIC] Ship it [Music]")).toBe("Ship it");
  });

  it("drops markers followed by punctuation", () => {
    expect(cleanTranscript("[MUSIC]. Ship it (laughs), now")).toBe("Ship it now");
  });

  it("keeps parentheses that are part of speech", () => {
    expect(cleanTranscript("call foo(bar) now")).toBe("call foo(bar) now");
    expect(cleanTranscript("an array[0] index")).toBe("an array[0] index");
  });

  it("builds whisper-cli arguments", () => {
    expect(whisperArgs({ model: "m", wav: "w", threads: 4 })).toEqual([
      "-m",
      "m",
      "-f",
      "w",
      "-l",
      "auto",
      "-nt",
      "-np",
      "-t",
      "4",
    ]);
  });
});
