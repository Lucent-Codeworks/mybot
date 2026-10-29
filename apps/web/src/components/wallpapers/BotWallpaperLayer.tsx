import { useAtomValue } from "@effect/atom-react";
import type { BotWallpaper, BotWallpaperPhotoId, EnvironmentId } from "@mybot/contracts";

import { cn } from "~/lib/utils";
import { wallpaperPhotoUrlAtom } from "~/state/botWallpapers";
import { botWallpaperStyle } from "./botWallpaperPresets";

/**
 * A bot's chat wallpaper, filling its positioned parent behind the content.
 * Static on purpose: no animation, so it never repaints while you read.
 */
export function BotWallpaperLayer(props: {
  readonly wallpaper: BotWallpaper | null | undefined;
  readonly environmentId: EnvironmentId;
  readonly className?: string;
}) {
  const { wallpaper } = props;
  if (wallpaper?.kind === "photo") {
    return (
      <WallpaperPhoto
        environmentId={props.environmentId}
        photoId={wallpaper.photoId}
        className={props.className}
      />
    );
  }
  const style = botWallpaperStyle(wallpaper);
  if (style === null) return null;
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0", props.className)}
      style={style}
    />
  );
}

function WallpaperPhoto(props: {
  readonly environmentId: EnvironmentId;
  readonly photoId: BotWallpaperPhotoId;
  readonly className?: string | undefined;
}) {
  const url = useAtomValue(wallpaperPhotoUrlAtom(props.environmentId, props.photoId));
  if (url === null) return null;
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 bg-cover bg-center", props.className)}
      style={{ backgroundImage: `url("${url}")` }}
    >
      {/* A wash of the theme background keeps message text legible over any photo. */}
      <div className="absolute inset-0 bg-background/75" />
    </div>
  );
}
