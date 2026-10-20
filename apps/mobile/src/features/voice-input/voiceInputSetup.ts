import { runAtomCommand } from "@mybot/client-runtime/state/runtime";
import { VOICE_SETUP_TITLE } from "@mybot/client-runtime/voice-input";
import { DEFAULT_VOICE_MODEL, type EnvironmentId } from "@mybot/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { Alert } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { voiceInputEnvironment } from "../../state/voice-input";
import { voiceSetupAlert } from "./voiceInputPresentation";

/**
 * Asks to download the default speech model on `environmentId`. Download only
 * installs; the user taps the mic again once Settings shows it ready.
 */
export function promptVoiceInputSetup(environmentId: EnvironmentId): void {
  const status = Option.getOrNull(
    AsyncResult.value(
      appAtomRegistry.get(voiceInputEnvironment.status({ environmentId, input: {} })),
    ),
  );
  const canInstall = appAtomRegistry.get(
    voiceInputEnvironment.install.permissionAtom(environmentId),
  );
  const alert = voiceSetupAlert(status, canInstall);
  if (alert.action === null) {
    Alert.alert(VOICE_SETUP_TITLE, alert.message);
    return;
  }
  Alert.alert(VOICE_SETUP_TITLE, alert.message, [
    { text: "Not now", style: "cancel" },
    {
      text: alert.action,
      onPress: () =>
        void runAtomCommand(appAtomRegistry, voiceInputEnvironment.install, {
          environmentId,
          input: { model: DEFAULT_VOICE_MODEL },
        }),
    },
  ]);
}
