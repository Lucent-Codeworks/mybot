import { useAtomValue } from "@effect/atom-react";
import {
  voiceModelChoices,
  voiceStatusLabel,
  VOICE_OWNER_NOTICE,
} from "@mybot/client-runtime/voice-input";
import { DEFAULT_VOICE_MODEL, type EnvironmentId, type VoiceModelId } from "@mybot/contracts";
import { useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { useVoiceInputStatus, voiceInputEnvironment } from "../../state/voiceInput";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";

const CHOICES = voiceModelChoices();
const SELECT_ITEMS = CHOICES.map((choice) => ({
  value: choice.id,
  label: `${choice.label} (${choice.sizeLabel})`,
}));

function VoiceEnvironmentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
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
  const title = props.label ? `Voice input · ${props.label}` : "Voice input";

  return (
    <SettingsRow
      {...searchableSetting("voice-model")}
      title={title}
      description={
        <span className="block">
          <span className="block">{status ? voiceStatusLabel(status) : "Checking…"}</span>
          {!canInstall && !unsupported ? <span className="block">{VOICE_OWNER_NOTICE}</span> : null}
        </span>
      }
      serverScoped
      control={
        unsupported ? null : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Select
              items={SELECT_ITEMS}
              value={selected}
              disabled={!canInstall || downloading}
              onValueChange={(value) => value !== null && setChosen(value)}
            >
              <SelectTrigger size="xs" className="w-56" aria-label="Speech model">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {SELECT_ITEMS.map(({ value, label }) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {downloading ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!canCancel}
                onClick={() => void cancelInstall({ environmentId, input: {} })}
              >
                Cancel
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    !canInstall || !status || (installed !== null && selected === installed)
                  }
                  onClick={() => {
                    void install({ environmentId, input: { model: selected } });
                    setChosen(null);
                  }}
                >
                  {installed !== null ? "Switch" : "Download"}
                </Button>
                {installed !== null ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canRemove}
                    onClick={() => void remove({ environmentId, input: {} })}
                  >
                    Remove
                  </Button>
                ) : null}
              </>
            )}
          </div>
        )
      }
    />
  );
}

export function VoiceSettingsPanel() {
  const { connectedEnvironments } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection id="voice" title="Voice input">
        {connectedEnvironments.map((environment) => (
          <VoiceEnvironmentRow
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={connectedEnvironments.length > 1 ? environment.label : null}
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
