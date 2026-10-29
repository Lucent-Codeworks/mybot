import type { BotProfile, BotWallpaper, EnvironmentId } from "@mybot/contracts";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { uploadImageAttachment } from "~/lib/attachmentUploadQueue";
import { cn } from "~/lib/utils";
import { saveWallpaperPhoto } from "~/state/botWallpapers";
import { useAtomCommand } from "~/state/use-atom-command";

import { parsePictureFile, PetFileError } from "../pets/petFiles";
import { toastManager } from "../ui/toast";
import { BotWallpaperLayer } from "../wallpapers/BotWallpaperLayer";
import { BOT_WALLPAPER_COLORS, BOT_WALLPAPER_PRESETS } from "../wallpapers/botWallpaperPresets";
import { FileButton } from "./BotPetSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const sameWallpaper = (a: BotWallpaper | null | undefined, b: BotWallpaper | null) => {
  if (a == null || b === null) return (a ?? null) === b;
  return JSON.stringify(a) === JSON.stringify(b);
};

/** One choice, previewed with the wallpaper itself behind a pretend message. */
function WallpaperTile(props: {
  readonly label: string;
  readonly wallpaper: BotWallpaper | null;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.selected}
      disabled={props.disabled}
      onClick={props.onSelect}
      className={cn(
        "relative h-16 w-full overflow-hidden rounded-lg border bg-background text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-60",
        props.selected ? "border-primary ring-2 ring-primary/40 ring-inset" : "border-border",
      )}
    >
      <BotWallpaperLayer wallpaper={props.wallpaper} environmentId={props.environmentId} />
      <span className="absolute right-1.5 bottom-1.5 left-4 h-2.5 rounded-full bg-primary/70" />
      <span className="absolute top-2 left-1.5 h-2.5 w-2/3 rounded-full bg-foreground/20" />
      {props.selected ? (
        <CheckIcon className="absolute top-1 right-1 size-3.5 rounded-full bg-primary p-0.5 text-primary-foreground" />
      ) : null}
      <span className="sr-only">{props.label}</span>
    </button>
  );
}

/** Picks the wallpaper behind this bot's chats: a preset, a color, or a photo. */
export function BotWallpaperSettings(props: {
  readonly bot: BotProfile;
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onChange: (bot: BotProfile) => void;
}) {
  const { bot, environmentId, onChange } = props;
  const savePhoto = useAtomCommand(saveWallpaperPhoto, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = bot.wallpaper ?? null;
  const choose = (wallpaper: BotWallpaper | null) => onChange({ ...bot, wallpaper });

  const usePhoto = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const photo = parsePictureFile(file);
      const attachmentId = await uploadImageAttachment({ environmentId, file: photo.image });
      const result = await savePhoto({ environmentId, input: { attachmentId } });
      if (result._tag === "Success") choose({ kind: "photo", photoId: result.value.photoId });
      else
        toastManager.add({
          type: "error",
          title: "Could not use the photo",
          description: "Try another image.",
        });
    } catch (cause) {
      if (cause instanceof PetFileError) setError(cause.message);
      else
        toastManager.add({
          type: "error",
          title: "Could not use the photo",
          description: cause instanceof Error ? cause.message : "An error occurred.",
        });
    } finally {
      setBusy(false);
    }
  };

  const tiles: ReadonlyArray<{ label: string; wallpaper: BotWallpaper | null }> = [
    { label: "No wallpaper", wallpaper: null },
    ...BOT_WALLPAPER_PRESETS.map((preset) => ({
      label: preset.label,
      wallpaper: { kind: "preset", id: preset.id } as const,
    })),
    ...BOT_WALLPAPER_COLORS.map((color) => ({
      label: `Color ${color}`,
      wallpaper: { kind: "color", color } as const,
    })),
    ...(current?.kind === "photo" ? [{ label: "Your photo", wallpaper: current }] : []),
  ];
  const disabled = props.disabled || busy;

  return (
    <SettingsSection title="Wallpaper">
      <div className="grid grid-cols-4 gap-2 px-4 py-3 sm:grid-cols-6">
        {tiles.map((tile) => (
          <WallpaperTile
            key={tile.label}
            label={tile.label}
            wallpaper={tile.wallpaper}
            selected={sameWallpaper(current, tile.wallpaper)}
            disabled={disabled}
            environmentId={environmentId}
            onSelect={() => choose(tile.wallpaper)}
          />
        ))}
      </div>
      <SettingsRow
        title="Your own"
        description={
          error ?? "Use a photo, or any color. It shows behind this bot's chats on every device."
        }
        control={
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label="Pick a color"
              disabled={disabled}
              value={current?.kind === "color" ? current.color : "#bcd8f0"}
              onChange={(event) => choose({ kind: "color", color: event.currentTarget.value })}
              className="h-8 w-10 cursor-pointer rounded-md border border-border bg-transparent disabled:cursor-default"
            />
            <FileButton
              label="Choose photo…"
              accept=".png,.webp,.jpg,.jpeg,.gif"
              disabled={disabled}
              onFiles={(files) => void usePhoto(files[0]!)}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}
