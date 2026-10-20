import type { EnvironmentId, PetId } from "@mybot/contracts";

import {
  useClientSettings,
  useEnvironmentSettings,
  useUpdateClientSettings,
  useUpdateEnvironmentSettings,
} from "~/hooks/useSettings";
import { usePrimaryEnvironmentId } from "~/state/environments";

import { PetLibraryRow, usePetLibrary } from "../pets/PetLibraryRow";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useOptionalSettingsScope } from "./SettingsScopeContext";

const NO_PET = "none";

/** Settings → Appearance → Pets: the device's Show pets toggle and the environment's pets. */
export function PetsAppearanceSettings() {
  const petsEnabled = useClientSettings((settings) => settings.petsEnabled);
  const updateClientSettings = useUpdateClientSettings();
  const scope = useOptionalSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = scope?.target?.environmentId ?? primaryEnvironmentId;

  return (
    <SettingsSection {...searchableSetting("pets")}>
      <SettingsRow
        title="Show pets"
        description="A bot's pet sits beside the composer and reacts to its work. Applies to this device."
        control={
          <Switch
            checked={petsEnabled}
            onCheckedChange={(checked) => void updateClientSettings({ petsEnabled: checked })}
            aria-label="Show pets"
          />
        }
      />
      {environmentId ? (
        <PetLibrarySettings environmentId={environmentId} />
      ) : (
        <SettingsRow title="Pets" description="Connect to MyBot to manage pets." />
      )}
    </SettingsSection>
  );
}

function PetLibrarySettings({ environmentId }: { environmentId: EnvironmentId }) {
  const library = usePetLibrary(environmentId);
  const defaultPetId = useEnvironmentSettings(environmentId, (settings) => settings.defaultPetId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const defaultPet = library.pets.find((pet) => pet.id === defaultPetId) ?? null;

  return (
    <>
      <SettingsRow
        title="Default pet"
        description="The pet for bots that don't pick their own."
        control={
          <Select
            value={defaultPet?.id ?? NO_PET}
            onValueChange={(value) =>
              updateSettings({ defaultPetId: value === NO_PET ? null : (value as PetId) })
            }
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-48"
              aria-label="Default pet"
              disabled={!library.loaded}
            >
              <SelectValue>{defaultPet?.displayName ?? "None"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={NO_PET}>
                None
              </SelectItem>
              {library.pets.map((pet) => (
                <SelectItem hideIndicator key={pet.id} value={pet.id}>
                  {pet.displayName}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {library.error ? <SettingsRow title="Pets" description={library.error} /> : null}
      {library.pets.map((pet) => (
        <PetLibraryRow
          key={pet.id}
          environmentId={environmentId}
          pet={pet}
          canOperate={library.canOperate}
          onChanged={library.refresh}
        />
      ))}
    </>
  );
}
