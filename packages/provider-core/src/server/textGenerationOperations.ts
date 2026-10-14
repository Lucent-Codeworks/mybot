/**
 * The text generation operations every provider shares. A provider supplies a
 * runner that sends one prompt and decodes the reply; prompts and output
 * sanitizing live here so providers cannot drift on them.
 *
 * @module textGeneration/TextGenerationOperations
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ChatAttachment, ModelSelection } from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { type ProviderTextGeneration, TextGenerationError } from "./textGeneration.ts";
import { buildActionReviewPrompt, buildThreadTitlePrompt } from "./textGenerationPrompts.ts";
import { sanitizeThreadTitle } from "./textGenerationUtils.ts";

export type Operation = keyof ProviderTextGeneration;

/**
 * One prompt for a provider to run. The prompt carries everything, so the model
 * runs with no tools at all.
 */
export interface Request<S extends Schema.Top> {
  readonly operation: Operation;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
  /** The user's attachments, already listed in the prompt. Providers that accept images send them. */
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
}

/** Runs one request and decodes the reply as its `outputSchema`. */
export type Runner = <S extends Schema.Top>(
  request: Request<S>,
) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

/** Decodes the JSON object in a text reply, which models often wrap in prose. */
export const decodeJsonReply = <S extends Schema.Top>(
  request: Pick<Request<S>, "operation" | "outputSchema">,
  provider: string,
  text: string,
) => {
  // Each request builds its own output schema, so the decoder cannot be hoisted.
  const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(request.outputSchema));
  return decodeOutput(extractJsonObject(text)).pipe(
    Effect.mapError(
      (cause) =>
        new TextGenerationError({
          operation: request.operation,
          detail: `${provider} returned invalid structured output.`,
          cause,
        }),
    ),
  );
};

/** The text generation service over `run`. `name` prefixes each operation's span. */
export function fromRunner(name: string, run: Runner): ProviderTextGeneration {
  const generateThreadTitle: ProviderTextGeneration["generateThreadTitle"] = Effect.fn(
    `${name}.generateThreadTitle`,
  )(function* (input) {
    const generated = yield* run({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      modelSelection: input.modelSelection,
      attachments: input.attachments,
      ...buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      }),
    });
    return {
      title: sanitizeThreadTitle(generated.title),
      ...(generated.needsRefinement ? { needsRefinement: true } : {}),
    };
  });

  const reviewAction: ProviderTextGeneration["reviewAction"] = Effect.fn(`${name}.reviewAction`)(
    function* (input) {
      return yield* run({
        operation: "reviewAction",
        cwd: input.cwd,
        modelSelection: input.modelSelection,
        ...buildActionReviewPrompt({ action: input.action, rules: input.rules }),
      });
    },
  );

  return { generateThreadTitle, reviewAction } satisfies ProviderTextGeneration;
}
