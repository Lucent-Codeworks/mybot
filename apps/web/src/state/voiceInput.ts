import { createVoiceInputEnvironment } from "@mybot/client-runtime/state/voice-input";
import type { EnvironmentId, VoiceInputStatus } from "@mybot/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const voiceInputEnvironment = createVoiceInputEnvironment(connectionAtomRuntime);

/** Live speech model status, or null while unknown. Pass null to stay unsubscribed. */
export function useVoiceInputStatus(environmentId: EnvironmentId | null): VoiceInputStatus | null {
  return useEnvironmentQuery(
    environmentId === null ? null : voiceInputEnvironment.status({ environmentId, input: {} }),
  ).data;
}
