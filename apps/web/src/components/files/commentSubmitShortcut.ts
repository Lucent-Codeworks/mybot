interface CommentSubmitShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/** Guard for inline comment composers that submit on Command/Ctrl+Enter. */
export function isCommentSubmitShortcut(event: CommentSubmitShortcutEvent, value: string): boolean {
  return (event.metaKey || event.ctrlKey) && event.key === "Enter" && value.trim().length > 0;
}
