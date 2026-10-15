import { findAppPreset } from "@t3tools/shared/appCatalog";
import { PlugIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ProjectMonogram } from "../ProjectMonogram";
import { APP_BRAND_ICONS } from "./appBrandIcons";

const TILE_SIZE = {
  sm: "size-5 rounded-sm",
  md: "size-9 rounded-lg",
  lg: "size-11 rounded-lg",
} as const;
const GLYPH_SIZE = { sm: "size-3", md: "size-5", lg: "size-6" } as const;

/** Near-black or near-white brand colors vanish on one theme, so they follow the text color. */
function readableBrandFill(hex: string): string {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance < 0.06 || luminance > 0.7 ? "currentColor" : `#${hex}`;
}

/**
 * An app's logo: its brand mark on a neutral tile, a lettered tile in the
 * preset's color when there is no mark, or a plug for a custom app.
 */
export function AppLogo(props: { presetId: string | null; size?: keyof typeof TILE_SIZE }) {
  const size = props.size ?? "md";
  const preset = props.presetId ? findAppPreset(props.presetId) : undefined;
  const icon = props.presetId ? APP_BRAND_ICONS[props.presetId] : undefined;
  if (preset && !icon) {
    return (
      <ProjectMonogram
        text={preset.name.slice(0, 1).toUpperCase()}
        color={preset.color}
        className={TILE_SIZE[size]}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center border border-border bg-background text-foreground",
        TILE_SIZE[size],
      )}
    >
      {icon ? (
        <svg viewBox="0 0 24 24" className={GLYPH_SIZE[size]} fill={readableBrandFill(icon.hex)}>
          <path d={icon.path} />
        </svg>
      ) : (
        <PlugIcon className={cn("text-muted-foreground", GLYPH_SIZE[size])} />
      )}
    </span>
  );
}
