import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { petPoseFor } from "@mybot/client-runtime/state/petMood";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@mybot/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type Pet,
  PET_DISPLAY_NAME_MAX_LENGTH,
  type PetSource,
} from "@mybot/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { readLocalApi } from "~/localApi";
import { petSpriteUrlAtom } from "~/state/assets";
import { petEnvironment } from "~/state/pets";
import { useAtomCommand } from "~/state/use-atom-command";

import { SettingsRow } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { downloadPetExport } from "./petExport";
import { PetSprite } from "./PetSprite";

const PET_SOURCE_LABELS: Readonly<Record<PetSource, string>> = {
  builtin: "Comes with MyBot",
  import: "Imported from ChatGPT",
  codex: "Imported from Codex",
  picture: "Made from a picture",
  hatched: "Created with AI",
};

const IDLE_POSE = petPoseFor("idle", false);

/** Shows a failed command as a toast; returns whether it succeeded. */
export function reportPetResult(
  title: string,
  result: AtomCommandResult<unknown, unknown>,
): boolean {
  if (result._tag === "Success") return true;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
  return false;
}

/** The environment's pets and hatch jobs, with a refresh to call after each change. */
export function usePetLibrary(environmentId: EnvironmentId) {
  const listAtom = petEnvironment.list({ environmentId, input: undefined });
  const result = useAtomValue(listAtom);
  const refresh = useAtomRefresh(listAtom);
  const canOperate = useAtomValue(petEnvironment.rename.permissionAtom(environmentId));
  const value = Option.getOrNull(AsyncResult.value(result));
  const failure = result._tag === "Failure" ? Cause.squash(result.cause) : null;
  return {
    pets: value?.pets ?? [],
    hatchJobs: value?.hatchJobs ?? [],
    loaded: value !== null,
    error:
      failure === null
        ? null
        : failure instanceof Error
          ? failure.message
          : "Pets could not be loaded.",
    refresh,
    canOperate,
  };
}

/** A still preview of the pet: the first idle frame. */
export function PetPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly pet: Pet;
  readonly width: number;
}) {
  const { environmentId, pet, width } = props;
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const url = useAtomValue(
    petSpriteUrlAtom({ environmentId, petId: pet.id, version: pet.updatedAt }),
  );
  // Reserve the sprite's box so the row does not shift when the URL arrives.
  if (!url) return <div aria-hidden style={{ width, height: (width * 208) / 192 }} />;
  return (
    <PetSprite pet={pet} url={url} pose={IDLE_POSE} reducedMotion={reducedMotion} width={width} />
  );
}

/**
 * One pet with Rename, Export, and Remove. Built-in pets can only be
 * exported. `onChanged` runs after a rename or removal lands.
 */
export function PetLibraryRow(props: {
  readonly environmentId: EnvironmentId;
  readonly pet: Pet;
  readonly canOperate: boolean;
  readonly onChanged: () => void;
  /** Replaces the pet's name as the row title, e.g. "Jarvis's pet: Bolt". */
  readonly title?: (name: string) => ReactNode;
  readonly previewWidth?: number;
  readonly children?: ReactNode;
}) {
  const { environmentId, pet, canOperate, onChanged } = props;
  const rename = useAtomCommand(petEnvironment.rename, { reportFailure: false });
  const remove = useAtomCommand(petEnvironment.remove, { reportFailure: false });
  const url = useAtomValue(
    petSpriteUrlAtom({ environmentId, petId: pet.id, version: pet.updatedAt }),
  );
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);

  const commitRename = async (value: string) => {
    setRenaming(false);
    const displayName = value.trim();
    if (!displayName || displayName === pet.displayName) return;
    setBusy(true);
    const result = await rename({ environmentId, input: { petId: pet.id, displayName } });
    setBusy(false);
    if (reportPetResult(`Could not rename ${pet.displayName}`, result)) onChanged();
  };

  const removePet = async () => {
    const api = readLocalApi();
    const confirmed = await api?.dialogs.confirm(
      `Remove ${pet.displayName}? Bots using it switch to the default pet.`,
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setBusy(true);
    const result = await remove({ environmentId, input: { petId: pet.id } });
    setBusy(false);
    if (reportPetResult(`Could not remove ${pet.displayName}`, result)) onChanged();
  };

  const exportPet = async () => {
    if (!url) return;
    setBusy(true);
    try {
      await downloadPetExport(pet, url);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not export ${pet.displayName}`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setBusy(false);
    }
  };

  const name = renaming ? (
    <Input
      size="sm"
      className="w-full sm:w-56"
      aria-label="Pet name"
      autoFocus
      maxLength={PET_DISPLAY_NAME_MAX_LENGTH}
      defaultValue={pet.displayName}
      onBlur={(event) => void commitRename(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setRenaming(false);
      }}
    />
  ) : (
    pet.displayName
  );

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-3">
          <PetPreview environmentId={environmentId} pet={pet} width={props.previewWidth ?? 32} />
          {renaming || !props.title ? name : props.title(pet.displayName)}
        </span>
      }
      description={PET_SOURCE_LABELS[pet.source]}
      control={
        <div className="flex items-center gap-1">
          {pet.builtIn ? null : (
            <Button
              size="sm"
              variant="ghost"
              disabled={!canOperate || busy || renaming}
              onClick={() => setRenaming(true)}
            >
              Rename
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={!url || busy}
            onClick={() => void exportPet()}
          >
            Export
          </Button>
          {pet.builtIn ? null : (
            <Button
              size="sm"
              variant="ghost-destructive"
              disabled={!canOperate || busy}
              onClick={() => void removePet()}
            >
              Remove
            </Button>
          )}
        </div>
      }
    >
      {props.children}
    </SettingsRow>
  );
}
