import type { EnvironmentId } from "@mybot/contracts";

import { toastManager } from "../../components/ui/toast";

/**
 * Opens the first-use prompt to download a speech model on `environmentId`.
 * Every voice entry point (mic button, `composer.voice`, command palette) lands
 * here when the server has no model yet.
 */
export function requestVoiceInputSetup(_environmentId: EnvironmentId): void {
  toastManager.add({
    type: "info",
    title: "Voice input is not set up on this MyBot server.",
    description: "It needs a speech model on your MyBot server first.",
  });
}
