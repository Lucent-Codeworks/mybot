import { describe, expect, it } from "vite-plus/test";

describe("composerChipSizeSuffix", () => {
  it("labels attachment records with a human size, matching web's chip", async () => {
    const { composerChipSizeSuffix } = await import("./composerChipPresentation");
    expect(composerChipSizeSuffix({ kind: "file", sizeBytes: 1024 })).toBe("1 KB");
    expect(composerChipSizeSuffix({ kind: "file", sizeBytes: 3_700_000 })).toBe("3.5 MB");
    expect(composerChipSizeSuffix({ kind: "image", sizeBytes: 2048 })).toBe("2 KB");
  });

  it("adds nothing for records that carry no bytes", async () => {
    const { composerChipSizeSuffix } = await import("./composerChipPresentation");
    // Terminal/review chips have no size to show.
    expect(composerChipSizeSuffix({ kind: "terminal" })).toBe("");
    expect(composerChipSizeSuffix({ kind: "file" })).toBe("");
    expect(composerChipSizeSuffix(undefined)).toBe("");
  });
});

describe("contextChipPresentation image detection", () => {
  it("treats a picture attached through the file picker as an image", async () => {
    const { contextChipPresentation } = await import("./composerChipPresentation");
    // The document picker types every pick as `file`, so the name has to carry the intent.
    expect(
      contextChipPresentation("file", { kind: "file", name: "IMG_4997.PNG", mimeType: "" }),
    ).toEqual({ accent: "#d55665", symbol: "photo" });
    expect(
      contextChipPresentation("file", {
        kind: "file",
        name: "shot",
        mimeType: "image/jpeg",
      }),
    ).toEqual({ accent: "#d55665", symbol: "photo" });
  });

  it("leaves genuine documents and videos alone", async () => {
    const { contextChipPresentation } = await import("./composerChipPresentation");
    expect(
      contextChipPresentation("file", { kind: "file", name: "notes.txt", mimeType: "text/plain" }),
    ).toEqual({ accent: "#0090cd", symbol: "doc" });
    expect(
      contextChipPresentation("file", { kind: "file", name: "clip.mp4", mimeType: "video/mp4" }),
    ).toEqual({ accent: "#d06217", symbol: "play.rectangle" });
  });
});
