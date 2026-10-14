import type { ChatAttachment, ModelSelection } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A failed text generation request. Server-only; it never crosses the wire. */
export class TextGenerationError extends Schema.TaggedError<TextGenerationError>()(
  "TextGenerationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Text generation failed in ${this.operation}: ${this.detail}`;
  }
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
}

export interface ActionReviewInput {
  cwd: string;
  /** What the agent wants to do, as its approval request describes it. */
  action: string;
  /** The bot's standing instructions, which may widen or narrow what is safe. */
  rules: string;
  modelSelection: ModelSelection;
}

export interface ActionReviewResult {
  /** `allow` lets the action run; `ask` leaves it for the user. */
  verdict: "allow" | "ask";
  reason: string;
}

/** Thread title generation backed by one provider instance. */
export interface ProviderTextGeneration {
  /** Generate a concise thread title from a first message or thread history. */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;
  /** Auto Review: decide whether a bot's proposed action is safe to run without the user. */
  readonly reviewAction: (
    input: ActionReviewInput,
  ) => Effect.Effect<ActionReviewResult, TextGenerationError>;
}
