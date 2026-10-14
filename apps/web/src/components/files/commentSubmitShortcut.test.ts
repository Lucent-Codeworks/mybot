import { describe, expect, it } from "vite-plus/test";

import { isCommentSubmitShortcut } from "./commentSubmitShortcut";

describe("isCommentSubmitShortcut", () => {
  it("accepts Command or Ctrl+Enter", () => {
    expect(
      isCommentSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false }, "Looks good"),
    ).toBe(true);
    expect(
      isCommentSubmitShortcut({ key: "Enter", metaKey: false, ctrlKey: true }, "Looks good"),
    ).toBe(true);
  });

  it("rejects empty comments and unrelated key presses", () => {
    expect(isCommentSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false }, "   ")).toBe(
      false,
    );
    expect(isCommentSubmitShortcut({ key: "K", metaKey: true, ctrlKey: false }, "Looks good")).toBe(
      false,
    );
  });
});
