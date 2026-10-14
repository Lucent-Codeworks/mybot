import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { FileCommentAnnotation } from "./FileCommentAnnotation";

const callbacks = {
  onCancel: vi.fn(),
  onComment: vi.fn(),
  onDelete: vi.fn(),
};

describe("FileCommentAnnotation", () => {
  it("renders the draft composer directly on the selected lines", () => {
    const markup = renderToStaticMarkup(
      <FileCommentAnnotation kind="draft" rangeLabel="L78" text="" {...callbacks} />,
    );

    expect(markup).toContain("font-sans");
    expect(markup).not.toContain("chat-composer-glass");
    expect(markup).not.toContain("font-mono");
    expect(markup).not.toContain("Local comment");
    expect(markup).not.toContain("on L78");
    expect(markup).toContain("⌘/Ctrl Enter to send");
    expect(markup).toContain("Add a comment…");
    expect(markup).toContain(">Comment</button>");
    expect(markup).toContain("autofocus");
    // The comment box is the standard small Textarea, not a bespoke surface.
    expect(markup).toMatch(/<span[^>]*data-size="sm"[^>]*data-slot="textarea-control"/);
  });

  it("renders a saved comment without a nested card or redundant range label", () => {
    const markup = renderToStaticMarkup(
      <FileCommentAnnotation
        kind="comment"
        rangeLabel="L78"
        text="Please keep this explicit."
        {...callbacks}
      />,
    );

    expect(markup).toContain("font-sans");
    expect(markup).not.toContain("chat-composer-glass");
    expect(markup).not.toContain("on L78");
    expect(markup).toContain("Please keep this explicit.");
    expect(markup).toContain('aria-label="Delete comment"');
    expect(markup).toContain("border-s-2");
    expect(markup).toContain("bg-primary/[0.045]");
    expect(markup).toContain("lucide-message-circle");
  });
});
