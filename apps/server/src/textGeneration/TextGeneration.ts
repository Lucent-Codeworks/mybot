import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type ProviderTextGeneration,
  TextGenerationError,
} from "@t3tools/provider-core/server/textGeneration";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

export type {
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

/**
 * TextGeneration - Service tag for thread title generation, routed to the
 * provider instance named by the request's model selection.
 */
export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return TextGeneration.of({
    generateThreadTitle: (input) =>
      registry.getInstance(input.modelSelection.instanceId).pipe(
        Effect.flatMap((instance) =>
          instance
            ? instance.textGeneration.generateThreadTitle(input)
            : Effect.fail(
                new TextGenerationError({
                  operation: "generateThreadTitle",
                  detail: `No provider instance registered for id '${input.modelSelection.instanceId}'.`,
                }),
              ),
        ),
      ),
  });
});

export const layer = Layer.effect(TextGeneration, make);
