import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@mybot/client-runtime/environment";
import { resolveBotPet } from "@mybot/client-runtime/state/petMood";
import { squashAtomCommandFailure } from "@mybot/client-runtime/state/runtime";
import {
  type BotProfile,
  type EnvironmentId,
  PET_DESCRIPTION_MAX_LENGTH,
  PET_DISPLAY_NAME_MAX_LENGTH,
  type PetHatchInput,
  type PetHatchJob,
  type PetId,
  type ProjectId,
} from "@mybot/contracts";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { uploadImageAttachment } from "~/lib/attachmentUploadQueue";
import { useThreadShell } from "~/state/entities";
import { petEnvironment } from "~/state/pets";
import { serverEnvironment } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { PetLibraryRow, reportPetResult, usePetLibrary } from "../pets/PetLibraryRow";
import { parsePetFiles, parsePictureFile, PetFileError } from "../pets/petFiles";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const NO_PET = "none";
const CODEX_UNAVAILABLE_MESSAGE = "Creating a pet with AI needs Codex signed in with ChatGPT.";

type PetScope = "bot" | "default";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function isCodexUnavailable(error: unknown): error is { message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "PetError" &&
    "code" in error &&
    error.code === "codex_unavailable"
  );
}

/**
 * Bot settings → Pet: the bot's pet, the three ways to get one, and whether
 * a choice applies to this bot or is the default for every bot.
 */
export function BotPetSettings(props: {
  readonly bot: BotProfile;
  readonly botName: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly disabled: boolean;
  readonly onChange: (bot: BotProfile) => void;
}) {
  const { bot, botName, environmentId, projectId, onChange } = props;
  const library = usePetLibrary(environmentId);
  const defaultPetId = useEnvironmentSettings(environmentId, (settings) => settings.defaultPetId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const disabled = props.disabled || !library.canOperate;
  const current = resolveBotPet({ bot, defaultPetId, pets: library.pets });
  // A bot without its own choice follows the default.
  const scope: PetScope = bot.petId === undefined ? "default" : "bot";

  const assign = (petId: PetId | null) => {
    if (petId === null) onChange({ ...bot, petId: null });
    else if (scope === "bot") onChange({ ...bot, petId });
    else updateSettings({ defaultPetId: petId });
  };

  const changeScope = (next: PetScope) => {
    if (next === scope) return;
    if (next === "bot") {
      onChange({ ...bot, petId: current?.id ?? null });
      return;
    }
    if (current) updateSettings({ defaultPetId: current.id });
    onChange({ ...bot, petId: undefined });
  };

  // An upload can outlast a profile change, so assign with the profile as it is then.
  const latestAssign = useRef(assign);
  useLayoutEffect(() => {
    latestAssign.current = assign;
  });
  const added = (petId: PetId) => {
    library.refresh();
    latestAssign.current(petId);
  };

  return (
    <SettingsSection {...searchableSetting("bot-pet")}>
      {library.error ? <SettingsRow title="Pets" description={library.error} /> : null}
      {current ? (
        <PetLibraryRow
          environmentId={environmentId}
          pet={current}
          canOperate={!disabled}
          onChanged={library.refresh}
          previewWidth={40}
          title={(name) => `${botName}'s pet: ${name}`}
        />
      ) : (
        <SettingsRow
          title="No pet"
          description={
            bot.petId === null
              ? `${botName} shows no pet.`
              : "Import one, use a picture, or create one with AI."
          }
        />
      )}
      <SettingsRow
        title="Pet"
        description="Pick from pets already in this environment."
        control={
          <Select
            value={current?.id ?? NO_PET}
            onValueChange={(value) => assign(value === NO_PET ? null : (value as PetId))}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-48"
              aria-label={`${botName}'s pet`}
              disabled={disabled || !library.loaded}
            >
              <SelectValue>{current?.displayName ?? "No pet"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={NO_PET}>
                No pet
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
      <SettingsRow
        title="Applies to"
        description="A pet for just this bot, or the default for bots that don't pick their own."
        control={
          <RadioGroup
            value={scope}
            disabled={disabled}
            onValueChange={(value) => changeScope(value as PetScope)}
          >
            <label className="flex items-center gap-2 text-sm">
              <Radio value="bot" />
              Just {botName}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Radio value="default" />
              Default for all bots
            </label>
          </RadioGroup>
        }
      />
      <ImportPetRow environmentId={environmentId} disabled={disabled} onAdded={added} />
      <PicturePetRow environmentId={environmentId} disabled={disabled} onAdded={added} />
      <HatchPetRow
        environmentId={environmentId}
        projectId={projectId}
        disabled={disabled}
        jobs={library.hatchJobs}
        refresh={library.refresh}
      />
    </SettingsSection>
  );
}

/** A Button that opens a hidden file input. */
function FileButton(props: {
  readonly label: string;
  readonly accept: string;
  readonly multiple?: boolean;
  readonly disabled: boolean;
  readonly onFiles: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={props.accept}
        multiple={props.multiple}
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          // Clear so choosing the same file again still fires a change.
          event.currentTarget.value = "";
          if (files.length > 0) props.onFiles(files);
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={props.disabled}
        onClick={() => inputRef.current?.click()}
      >
        {props.label}
      </Button>
    </>
  );
}

export function ImportPetRow(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onAdded: (petId: PetId) => void;
}) {
  const { environmentId, onAdded } = props;
  const importPet = useAtomCommand(petEnvironment.importPet, { reportFailure: false });
  const codexResult = useAtomValue(petEnvironment.listCodex({ environmentId, input: undefined }));
  const found = Option.getOrNull(AsyncResult.value(codexResult)) ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const importFiles = async (files: File[]) => {
    setBusy("files");
    setError(null);
    try {
      const parsed = await parsePetFiles(files);
      const attachmentId = await uploadImageAttachment({ environmentId, file: parsed.image });
      const result = await importPet({
        environmentId,
        input: {
          type: "upload",
          attachmentId,
          displayName: parsed.displayName,
          description: parsed.description,
        },
      });
      if (result._tag === "Success") onAdded(result.value.id);
      else reportPetResult("Could not import the pet", result);
    } catch (cause) {
      if (cause instanceof PetFileError) setError(cause.message);
      else
        toastManager.add({
          type: "error",
          title: "Could not import the pet",
          description: errorMessage(cause),
        });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsRow
      title="Import"
      description={
        error ?? "A pet you downloaded from ChatGPT, or one from your Codex pets folder."
      }
      control={
        <FileButton
          label="Choose files…"
          accept=".png,.webp,.json,.zip"
          multiple
          disabled={props.disabled || busy !== null}
          onFiles={(files) => void importFiles(files)}
        />
      }
    >
      {found.length > 0 ? (
        <div className="flex flex-col gap-2 pb-3">
          <span className="text-xs text-muted-foreground">Found on this environment’s host</span>
          {found.map((candidate) => {
            const key = `${candidate.providerInstanceId}:${candidate.folderName}`;
            return (
              <div key={key} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  {candidate.displayName || candidate.folderName}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={props.disabled || busy !== null}
                  onClick={async () => {
                    setBusy(key);
                    const result = await importPet({
                      environmentId,
                      input: {
                        type: "codex",
                        providerInstanceId: candidate.providerInstanceId,
                        folderName: candidate.folderName,
                      },
                    });
                    setBusy(null);
                    if (result._tag === "Success") onAdded(result.value.id);
                    else reportPetResult(`Could not import ${candidate.displayName}`, result);
                  }}
                >
                  Import
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}
    </SettingsRow>
  );
}

export function PicturePetRow(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onAdded: (petId: PetId) => void;
}) {
  const { environmentId, onAdded } = props;
  const createPicture = useAtomCommand(petEnvironment.createPicture, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addPicture = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const picture = parsePictureFile(file);
      const attachmentId = await uploadImageAttachment({ environmentId, file: picture.image });
      const result = await createPicture({
        environmentId,
        input: { attachmentId, displayName: picture.displayName },
      });
      if (result._tag === "Success") onAdded(result.value.id);
      else reportPetResult("Could not use the picture", result);
    } catch (cause) {
      if (cause instanceof PetFileError) setError(cause.message);
      else
        toastManager.add({
          type: "error",
          title: "Could not use the picture",
          description: errorMessage(cause),
        });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsRow
      title="Use a picture"
      description={error ?? "Any image. MyBot adds simple motion for each mood."}
      control={
        <FileButton
          label="Choose image…"
          accept=".png,.webp,.jpg,.jpeg,.gif"
          disabled={props.disabled || busy}
          onFiles={(files) => void addPicture(files[0]!)}
        />
      }
    />
  );
}

export function HatchPetRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** Names the bot that gets the pet, for surfaces outside that bot's settings. */
  readonly botName?: string;
  readonly disabled: boolean;
  readonly jobs: ReadonlyArray<PetHatchJob>;
  readonly refresh: () => void;
}) {
  const { environmentId, projectId, refresh } = props;
  const hatch = useAtomCommand(petEnvironment.hatch, { reportFailure: false });
  const interrupt = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [codexRefused, setCodexRefused] = useState<string | null>(null);
  // The server decides; this only says so before the click.
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const codexSignedIn =
    providers?.some(
      (provider) =>
        provider.driver === "codex" &&
        provider.enabled &&
        provider.auth.status === "authenticated" &&
        provider.auth.type === "chatgpt",
    ) ?? false;
  const codexUnavailable =
    codexRefused ?? (providers !== null && !codexSignedIn ? CODEX_UNAVAILABLE_MESSAGE : null);
  const descriptionId = useId();

  // Only this bot's latest job shows, and only while it hatches or after it failed.
  const latest = props.jobs
    .filter((job) => job.projectId === projectId)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const job = latest?.status === "hatching" || latest?.status === "failed" ? latest : null;
  const hatchingThreadRef =
    job?.status === "hatching" ? scopeThreadRef(environmentId, job.threadId) : null;
  const runStatus = useThreadShell(hatchingThreadRef)?.latestRun?.status ?? null;
  // The job settles when its thread's run does; re-read the list then, no polling.
  const lastRunStatus = useRef(runStatus);
  useEffect(() => {
    if (lastRunStatus.current === runStatus) return;
    lastRunStatus.current = runStatus;
    refresh();
  }, [refresh, runStatus]);

  const start = async (input: Omit<PetHatchInput, "projectId">) => {
    setBusy(true);
    try {
      const result = await hatch({ environmentId, input: { projectId, ...input } });
      if (result._tag === "Success") {
        setName("");
        setDescription("");
        setReference(null);
        refresh();
        return;
      }
      const error = squashAtomCommandFailure(result);
      if (isCodexUnavailable(error)) setCodexRefused(error.message);
      else reportPetResult("Could not start creating the pet", result);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const displayName = name.trim();
    const text = description.trim();
    if (!displayName || !text) return;
    if (!reference) return start({ displayName, description: text });
    setBusy(true);
    let referenceAttachmentId: string;
    try {
      referenceAttachmentId = await uploadImageAttachment({
        environmentId,
        file: parsePictureFile(reference).image,
      });
    } catch (cause) {
      setBusy(false);
      toastManager.add({
        type: "error",
        title: "Could not upload the reference image",
        description: errorMessage(cause),
      });
      return;
    }
    await start({
      displayName,
      description: text,
      referenceAttachmentId,
    });
  };

  if (job?.status === "hatching") {
    return (
      <SettingsRow
        title="Create with AI"
        description={
          <>
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(scopeThreadRef(environmentId, job.threadId))}
              className="underline underline-offset-4"
            >
              Hatching {job.displayName}…
            </Link>{" "}
            You can leave this page; the pet shows up here when it's ready.
          </>
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={props.disabled || busy}
            onClick={async () => {
              setBusy(true);
              const result = await interrupt({ environmentId, input: { threadId: job.threadId } });
              setBusy(false);
              reportPetResult("Could not cancel", result);
              refresh();
            }}
          >
            Cancel
          </Button>
        }
      />
    );
  }

  const canHatch = !props.disabled && !busy && providers !== null && codexUnavailable === null;
  return (
    <SettingsRow
      title="Create with AI"
      description={
        codexUnavailable ??
        (props.botName
          ? `Describe a character and AI draws every mood. It becomes ${props.botName}'s pet. Needs Codex.`
          : "Describe a character and AI draws every mood. Needs Codex.")
      }
    >
      <div className="flex flex-col gap-2 pb-3">
        {job?.status === "failed" ? (
          <div className="flex items-center justify-between gap-3 text-sm text-destructive-foreground">
            <span className="min-w-0">
              {job.displayName} couldn't be created: {job.error ?? "the run stopped."}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={!canHatch}
              onClick={() =>
                void start({ displayName: job.displayName, description: job.description })
              }
            >
              Retry
            </Button>
          </div>
        ) : null}
        <Input
          size="sm"
          aria-label="Pet name"
          placeholder="Name"
          maxLength={PET_DISPLAY_NAME_MAX_LENGTH}
          disabled={!canHatch}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <Textarea
          size="sm"
          aria-describedby={descriptionId}
          aria-label="Describe the pet"
          placeholder="A tiny silver robot with a cyan visor"
          maxLength={PET_DESCRIPTION_MAX_LENGTH}
          disabled={!canHatch}
          value={description}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <FileButton
              label={reference ? "Change reference image" : "Reference image (optional)"}
              accept=".png,.webp,.jpg,.jpeg,.gif"
              disabled={!canHatch}
              onFiles={(files) => setReference(files[0]!)}
            />
            {reference ? (
              <>
                <span className="min-w-0 truncate">{reference.name}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canHatch}
                  onClick={() => setReference(null)}
                >
                  Remove
                </Button>
              </>
            ) : null}
          </div>
          <Button
            size="sm"
            disabled={!canHatch || !name.trim() || !description.trim()}
            onClick={() => void submit()}
          >
            Hatch pet
          </Button>
        </div>
        <span id={descriptionId} className="text-xs text-muted-foreground">
          Takes a few minutes and uses your Codex usage.
        </span>
      </div>
    </SettingsRow>
  );
}
