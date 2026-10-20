import type { EnvironmentId } from "@mybot/contracts";
import { create } from "zustand";

/** The server whose first-use prompt is open; `VoiceSetupDialogHost` renders it. */
export const useVoiceSetupRequest = create<{ environmentId: EnvironmentId | null }>(() => ({
  environmentId: null,
}));

/**
 * Opens the first-use prompt to download a speech model on `environmentId`.
 * Every voice entry point (mic button, `composer.voice`, command palette) lands
 * here when the server has no model yet.
 */
export function requestVoiceInputSetup(environmentId: EnvironmentId): void {
  useVoiceSetupRequest.setState({ environmentId });
}

export function closeVoiceInputSetup(): void {
  useVoiceSetupRequest.setState({ environmentId: null });
}
