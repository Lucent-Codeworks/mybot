import type { EnvironmentId, PetId, PetHatchJob, ProjectId } from "@mybot/contracts";
import { useMemo, useState } from "react";

import {
  useClientSettings,
  useEnvironmentSettings,
  useUpdateClientSettings,
  useUpdateEnvironmentSettings,
} from "~/hooks/useSettings";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";

import { PetLibraryRow, usePetLibrary } from "../pets/PetLibraryRow";
import { HatchPetRow, ImportPetRow, PicturePetRow } from "./BotPetSettings";
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
      <ImportPetRow
        environmentId={environmentId}
        disabled={!library.canOperate}
        onAdded={library.refresh}
      />
      <PicturePetRow
        environmentId={environmentId}
        disabled={!library.canOperate}
        onAdded={library.refresh}
      />
      <HatchForBotRows
        environmentId={environmentId}
        disabled={!library.canOperate}
        jobs={library.hatchJobs}
        refresh={library.refresh}
      />
    </>
  );
}

/**
 * Create with AI from Appearance. A hatch runs as a conversation in a bot and
 * the finished pet goes to that bot, so the user picks which one; the
 * built-in MyBot comes first.
 */
function HatchForBotRows(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly jobs: ReadonlyArray<PetHatchJob>;
  readonly refresh: () => void;
}) {
  const { environmentId } = props;
  const projects = useProjects();
  const bots = useMemo(
    () =>
      projects
        .filter((project) => project.environmentId === environmentId && project.bot != null)
        .toSorted(
          (left, right) =>
            Number(right.bot?.orchestrator === true) - Number(left.bot?.orchestrator === true),
        ),
    [environmentId, projects],
  );
  const [chosenId, setChosenId] = useState<ProjectId | null>(null);
  const bot = bots.find((candidate) => candidate.id === chosenId) ?? bots[0];
  if (!bot) return null;

  return (
    <>
      {bots.length > 1 ? (
        <SettingsRow
          title="Create for"
          description="The bot whose conversation draws the pet. The pet becomes its pet."
          control={
            <Select value={bot.id} onValueChange={(value) => setChosenId(value as ProjectId)}>
              <SelectTrigger
                size="sm"
                className="w-full sm:w-48"
                aria-label="Bot to create the pet for"
                disabled={props.disabled}
              >
                <SelectValue>{bot.title}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {bots.map((candidate) => (
                  <SelectItem hideIndicator key={candidate.id} value={candidate.id}>
                    {candidate.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      <HatchPetRow
        environmentId={environmentId}
        projectId={bot.id}
        botName={bot.title}
        disabled={props.disabled}
        jobs={props.jobs}
        refresh={props.refresh}
      />
    </>
  );
}
