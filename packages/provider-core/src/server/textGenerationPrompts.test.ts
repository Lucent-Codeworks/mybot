import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { buildActionReviewPrompt, buildThreadTitlePrompt } from "./textGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./textGenerationUtils.ts";
import { TextGenerationError } from "./textGeneration.ts";

describe("buildThreadTitlePrompt", () => {
  it("requires each generated field in the strict response schema", () => {
    const { outputSchema } = buildThreadTitlePrompt({ message: "Fix this" });
    expect(toJsonSchemaObject(outputSchema)).toMatchObject({
      required: ["title", "needsRefinement"],
      properties: { title: { type: "string" }, needsRefinement: { type: "boolean" } },
    });
  });

  it("includes the user message without absent attachment metadata", () => {
    const result = buildThreadTitlePrompt({
      message: "Investigate reconnect regressions after session restore",
    });

    expect(result.prompt).toContain("User message:");
    expect(result.prompt).toContain("Investigate reconnect regressions after session restore");
    expect(result.prompt).not.toContain("Attachment metadata:");
  });

  it("includes attachment metadata when attachments are provided", () => {
    const result = buildThreadTitlePrompt({
      message: "Name this thread from the screenshot",
      attachments: [
        {
          type: "image" as const,
          id: "att-456",
          name: "thread.png",
          mimeType: "image/png",
          sizeBytes: 67890,
        },
      ],
    });

    expect(result.prompt).toContain("Attachment metadata:");
    expect(result.prompt).toContain("thread.png");
    expect(result.prompt).toContain("image/png");
    expect(result.prompt).toContain("67890 bytes");
  });

  it("regenerates from recent thread contents and identifies the previous title", () => {
    const result = buildThreadTitlePrompt({
      message: `USER:\nInvestigate reconnect regressions\n\nASSISTANT:\nThe remaining issue is stale session state`,
      previousTitle: "Investigate reconnect regressions",
    });

    expect(result.prompt).toContain(
      "Regenerate the title for an existing MyBot thread so the user can recognize it weeks later.",
    );
    expect(result.prompt).toContain('The previous title was "Investigate reconnect regressions".');
    expect(result.prompt).toContain("Thread contents:");
    expect(result.prompt).toContain("The remaining issue is stale session state");
  });

  it("keeps the latest thread contents when regeneration context is truncated", () => {
    const result = buildThreadTitlePrompt({
      message: `${"old context ".repeat(1_000)}\n\nASSISTANT:\nCurrent thread state`,
      previousTitle: "Old title",
    });

    expect(result.prompt).toContain("[Earlier content truncated]");
    expect(result.prompt).toContain("Current thread state");
    expect(result.prompt).not.toContain("[truncated]");
  });

  it("does not truncate an already-marked regeneration context twice", () => {
    const retainedContext = "x".repeat(7_998);
    const result = buildThreadTitlePrompt({
      message: `[Earlier content truncated]\n\n${retainedContext}`,
      previousTitle: "Old title",
    });

    expect(result.prompt).toContain(
      `Thread contents:\n[Earlier content truncated]\n\n${retainedContext}`,
    );
    expect(result.prompt.match(/\[Earlier content truncated\]/g)).toHaveLength(1);
  });
});

describe("sanitizeThreadTitle", () => {
  it.each([
    '{"title": "Refresh ev-stg APP ASG instances"}',
    '{\n  "title": "Refresh ev-stg APP ASG instances"\n}',
  ])("unwraps a JSON title before normalizing: %s", (raw) => {
    expect(sanitizeThreadTitle(raw)).toBe("Refresh ev-stg APP ASG instances");
  });

  it.each([
    "Rolling ES Refresh ev-stg",
    "Fix {title} interpolation",
    '{"title": 42}',
    '{"subject": "Fix parsing"}',
    '{"title": "unfinished}',
  ])("preserves text that is not a JSON title: %s", (raw) => {
    expect(sanitizeThreadTitle(raw)).toBe(raw);
  });

  it("normalizes the extracted title", () => {
    expect(sanitizeThreadTitle('{"title": "  Fix   reconnect failures  "}')).toBe(
      "Fix reconnect failures",
    );
    expect(sanitizeThreadTitle('{"title": "  "}')).toBe("New thread");
    expect(
      sanitizeThreadTitle(
        '{"title": "Reconnect failures after restart because the session state does not recover"}',
      ),
    ).toBe("Reconnect failures after restart because the session state does not recover");
  });

  it("keeps complete titles for client display truncation", () => {
    expect(
      sanitizeThreadTitle(
        '  "Reconnect failures after restart because the session state does not recover"  ',
      ),
    ).toBe("Reconnect failures after restart because the session state does not recover");
  });

  it("caps runaway titles so a paragraph cannot reach the sidebar", () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const title = sanitizeThreadTitle(words);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith("...")).toBe(true);
  });
});

describe("normalizeCliError", () => {
  it("detects 'Command not found' and includes CLI name in the message", () => {
    const error = normalizeCliError(
      "claude",
      "generateThreadTitle",
      new Error("Command not found: claude"),
      "Something went wrong",
    );

    expect(error).toBeInstanceOf(TextGenerationError);
    expect(error.detail).toContain("Claude CLI");
    expect(error.detail).toContain("not available on PATH");
  });

  it("uses the CLI name from the first argument for codex", () => {
    const error = normalizeCliError(
      "codex",
      "generateThreadTitle",
      new Error("Command not found: codex"),
      "Something went wrong",
    );

    expect(error).toBeInstanceOf(TextGenerationError);
    expect(error.detail).toContain("Codex CLI");
    expect(error.detail).toContain("not available on PATH");
  });

  it("returns the error as-is if it is already a TextGenerationError", () => {
    const existing = new TextGenerationError({
      operation: "generateThreadTitle",
      detail: "Already wrapped",
    });

    const result = normalizeCliError("claude", "generateThreadTitle", existing, "fallback");

    expect(result).toBe(existing);
  });

  it("wraps unknown non-Error values with the fallback message", () => {
    const result = normalizeCliError("codex", "generateThreadTitle", "string error", "fallback");

    expect(result).toBeInstanceOf(TextGenerationError);
    expect(result.detail).toBe("fallback");
  });

  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateThreadTitle",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("buildActionReviewPrompt", () => {
  it("asks for a conservative verdict on the action under the user's rules", () => {
    const { prompt, outputSchema } = buildActionReviewPrompt({
      action: "Kind: command\ngit push --force",
      rules: "Never push to main.",
    });
    expect(prompt).toContain("When in doubt, ask.");
    expect(prompt).toContain("Never push to main.");
    expect(prompt).toContain("git push --force");
    expect(
      Schema.decodeUnknownSync(outputSchema)({ verdict: "ask", reason: "Rewrites history." }),
    ).toEqual({ verdict: "ask", reason: "Rewrites history." });
    expect(() => Schema.decodeUnknownSync(outputSchema)({ verdict: "deny", reason: "" })).toThrow();
  });
});
