import { useAtomValue } from "@effect/atom-react";
import {
  voiceModelChoices,
  voiceModelName,
  voiceStatusLabel,
  VOICE_OWNER_NOTICE,
} from "@mybot/client-runtime/voice-input";
import { DEFAULT_VOICE_MODEL, type EnvironmentId, type VoiceModelId } from "@mybot/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useAtomCommand } from "../../state/use-atom-command";
import { useVoiceInputStatus, voiceInputEnvironment } from "../../state/voice-input";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";

const CHOICES = voiceModelChoices();

/**
 * Android voice input transcribes on this server: its speech model status,
 * picker, and download, cancel, and remove. iOS transcribes on device.
 */
export function VoiceSettingsSection(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const status = useVoiceInputStatus(environmentId);
  const canInstall = useAtomValue(voiceInputEnvironment.install.permissionAtom(environmentId));
  const canCancel = useAtomValue(voiceInputEnvironment.cancelInstall.permissionAtom(environmentId));
  const canRemove = useAtomValue(voiceInputEnvironment.remove.permissionAtom(environmentId));
  const install = useAtomCommand(voiceInputEnvironment.install, { label: "voice model download" });
  const cancelInstall = useAtomCommand(voiceInputEnvironment.cancelInstall, {
    label: "voice model cancel",
  });
  const remove = useAtomCommand(voiceInputEnvironment.remove, { label: "voice model remove" });
  const [chosen, setChosen] = useState<VoiceModelId | null>(null);

  const installed = status?.model ?? null;
  const selected = chosen ?? installed ?? status?.pendingModel ?? DEFAULT_VOICE_MODEL;
  const downloading = status?.phase === "downloading";
  const unsupported = status?.phase === "unsupported";

  return (
    <SettingsSection title="Voice input">
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">
          {status ? voiceStatusLabel(status) : "Checking…"}
        </Text>
        {!canInstall && !unsupported ? (
          <Text className="text-sm text-foreground-muted">{VOICE_OWNER_NOTICE}</Text>
        ) : null}
      </View>
      {unsupported ? null : (
        <>
          {CHOICES.map((choice) => (
            <SettingsChoiceRow
              key={choice.id}
              label={choice.label}
              description={choice.sizeLabel}
              selected={selected === choice.id}
              separated
              disabled={!canInstall || downloading}
              onPress={() => setChosen(choice.id)}
            />
          ))}
          {downloading ? (
            <SettingsActionRow
              icon="xmark"
              label="Cancel download"
              disabled={!canCancel}
              onPress={() => void cancelInstall({ environmentId, input: {} })}
            />
          ) : (
            <SettingsActionRow
              icon="arrow.down.circle"
              label={installed !== null ? `Switch to ${voiceModelName(selected)}` : "Download"}
              disabled={!canInstall || !status || (installed !== null && selected === installed)}
              onPress={() => {
                void install({ environmentId, input: { model: selected } });
                setChosen(null);
              }}
            />
          )}
          {installed !== null && !downloading ? (
            <SettingsActionRow
              icon="trash"
              label="Remove speech model"
              tone="danger"
              disabled={!canRemove}
              onPress={() => void remove({ environmentId, input: {} })}
            />
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
