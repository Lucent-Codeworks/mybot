import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProviderInstanceId } from "@t3tools/contracts";
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
  const route = <A>(
    operation: keyof ProviderTextGeneration,
    instanceId: ProviderInstanceId,
    use: (generation: ProviderTextGeneration) => Effect.Effect<A, TextGenerationError>,
  ) =>
    registry.getInstance(instanceId).pipe(
      Effect.flatMap((instance) =>
        instance
          ? use(instance.textGeneration)
          : Effect.fail(
              new TextGenerationError({
                operation,
                detail: `No provider instance registered for id '${instanceId}'.`,
              }),
            ),
      ),
    );
  return TextGeneration.of({
    generateThreadTitle: (input) =>
      route("generateThreadTitle", input.modelSelection.instanceId, (generation) =>
        generation.generateThreadTitle(input),
      ),
    reviewAction: (input) =>
      route("reviewAction", input.modelSelection.instanceId, (generation) =>
        generation.reviewAction(input),
      ),
  });
});

export const layer = Layer.effect(TextGeneration, make);
