import { MessageCircle, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

import { isCommentSubmitShortcut } from "./commentSubmitShortcut";

interface FileCommentAnnotationProps {
  kind: "draft" | "comment";
  rangeLabel: string;
  text: string;
  onCancel: () => void;
  onComment: (text: string) => void;
  onDelete?: () => void;
}

/** The inline comment shown on selected lines in the file preview. */
export function FileCommentAnnotation({
  kind,
  rangeLabel,
  text,
  onCancel,
  onComment,
  onDelete,
}: FileCommentAnnotationProps) {
  const [localDraftText, setLocalDraftText] = useState("");
  const displayedText = kind === "draft" ? localDraftText : text;
  const trimmedText = displayedText.trim();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    if (kind !== "draft") return;
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [kind]);

  if (kind === "comment") {
    return (
      <div
        data-file-comment-annotation
        className="group/comment flex min-w-0 items-start gap-2.5 border-s-2 border-primary/55 bg-primary/[0.045] px-3 py-2.5 font-sans text-foreground"
        contentEditable={false}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <MessageCircle className="mt-0.5 size-3.5 shrink-0 text-primary/70" aria-hidden="true" />
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-5">{displayedText}</p>
        {onDelete ? (
          <span className="-my-1 -mr-1 flex shrink-0 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100 max-sm:opacity-100">
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Delete comment"
              onClick={onDelete}
            >
              <Trash2 className="size-3" />
            </Button>
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-file-comment-annotation
      className="px-3 py-2 font-sans text-foreground"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Textarea
        ref={textareaRef}
        autoFocus
        size="sm"
        value={displayedText}
        placeholder="Add a comment…"
        aria-label={`Comment on lines ${rangeLabel}`}
        onChange={(event) => setLocalDraftText(event.target.value)}
        onFocus={(event) => {
          const end = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(end, end);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          if (isCommentSubmitShortcut(event, trimmedText)) {
            event.preventDefault();
            onComment(trimmedText);
          }
        }}
      />
      <div className="mt-1.5 flex items-center gap-1">
        <span className="mr-auto text-3xs text-muted-foreground/70">⌘/Ctrl Enter to send</span>
        <Button variant="ghost-muted" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={!trimmedText} onClick={() => onComment(trimmedText)}>
          Comment
        </Button>
      </div>
    </div>
  );
}
