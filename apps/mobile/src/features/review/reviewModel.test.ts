import { describe, expect, it } from "vite-plus/test";

import {
  buildReviewParsedDiff,
  getReviewFilePreviewState,
  type ReviewRenderableFile,
} from "./reviewModel";

function makeRenderableFile(
  input: Partial<ReviewRenderableFile> & Pick<ReviewRenderableFile, "path">,
): ReviewRenderableFile {
  return {
    id: input.path,
    cacheKey: input.path,
    previousPath: null,
    changeType: "new",
    additions: 0,
    deletions: 0,
    languageHint: null,
    additionLines: [],
    deletionLines: [],
    rows: [],
    ...input,
  };
}

describe("buildReviewParsedDiff", () => {
  it.each([
    ["a/example.ts", "a/example.ts"],
    ["b/example.ts", "b/example.ts"],
    ["a/before.ts", "b/after.ts"],
  ])("preserves repository paths from %s to %s", (previousPath, path) => {
    const parsed = buildReviewParsedDiff(
      [
        `diff --git a/${previousPath} b/${path}`,
        ...(previousPath === path
          ? []
          : ["similarity index 50%", `rename from ${previousPath}`, `rename to ${path}`]),
        `--- a/${previousPath}`,
        `+++ b/${path}`,
        "@@ -1 +1 @@",
        "-before",
        "+after",
      ].join("\n"),
      "repository-paths",
    );
    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") return;
    expect(parsed.files[0]).toMatchObject({
      path,
      previousPath: previousPath === path ? null : previousPath,
      additions: 1,
      deletions: 1,
    });
  });

  it("builds renderable rows from a unified patch", () => {
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/apps/mobile/src/a.ts b/apps/mobile/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/apps/mobile/src/a.ts",
        "+++ b/apps/mobile/src/a.ts",
        "@@ -1,2 +1,3 @@",
        "-const before = 1;",
        "+const after = 2;",
        "+console.log(after);",
        " return true;",
      ].join("\n"),
      "unit",
    );

    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") {
      return;
    }

    expect(parsed.fileCount).toBe(1);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(1);
    expect(parsed.files[0]).toMatchObject({
      path: "apps/mobile/src/a.ts",
      additions: 2,
      deletions: 1,
    });
    expect(parsed.files[0]?.rows).toEqual([
      expect.objectContaining({ kind: "hunk", header: "@@ -1,2 +1,3 @@" }),
      expect.objectContaining({
        kind: "line",
        change: "delete",
        oldLineNumber: 1,
        newLineNumber: null,
        content: "const before = 1;",
        comparison: { change: "add", tokenIndex: 0 },
      }),
      expect.objectContaining({
        kind: "line",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 1,
        content: "const after = 2;",
        comparison: { change: "delete", tokenIndex: 0 },
      }),
      expect.objectContaining({
        kind: "line",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 2,
        content: "console.log(after);",
        comparison: null,
      }),
      expect.objectContaining({
        kind: "line",
        change: "context",
        oldLineNumber: 2,
        newLineNumber: 3,
        content: "return true;",
        comparison: null,
      }),
    ]);
  });

  it("treats truncated patches as partial diffs instead of failing", () => {
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/apps/mobile/src/a.ts b/apps/mobile/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/apps/mobile/src/a.ts",
        "+++ b/apps/mobile/src/a.ts",
        "@@ -1 +1,2 @@",
        " const before = 1;",
        "+const after = 2;",
        "",
        "[truncated]",
      ].join("\n"),
      "unit-truncated",
    );

    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") {
      return;
    }

    expect(parsed.notice).toContain("server size cap");
    expect(parsed.fileCount).toBe(1);
    expect(parsed.files[0]?.rows[0]).toMatchObject({
      kind: "hunk",
      header: "@@ -1,1 +1,2 @@",
    });
  });

  it("suppresses preview for non-text file formats", () => {
    const preview = getReviewFilePreviewState(
      makeRenderableFile({
        path: "apps/mobile/assets/icon.png",
      }),
    );

    expect(preview).toMatchObject({
      kind: "suppressed",
      reason: "non-text",
      title: "Non-text file",
      actionLabel: null,
    });
  });

  it("suppresses large diffs until explicitly requested", () => {
    const preview = getReviewFilePreviewState(
      makeRenderableFile({
        path: "apps/mobile/src/big.ts",
        rows: Array.from({ length: 401 }, (_, index) => ({
          kind: "line" as const,
          id: `line-${index}`,
          change: "add" as const,
          oldLineNumber: null,
          newLineNumber: index + 1,
          content: `const line${index} = ${index};`,
          additionTokenIndex: index,
          deletionTokenIndex: null,
          comparison: null,
        })),
      }),
    );

    expect(preview).toMatchObject({
      kind: "suppressed",
      reason: "large",
      title: "Large diff",
      actionLabel: "Load diff",
    });
  });
});
