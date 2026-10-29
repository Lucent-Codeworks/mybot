import type { BotWallpaper } from "@mybot/contracts";
import type { CSSProperties } from "react";

/**
 * The built-in chat wallpapers. Each is static CSS that mixes with the theme's
 * own background and foreground, so it reads in light and dark mode and keeps
 * message text legible without a per-theme variant.
 */

/** Paints at a low strength over the theme background, like WhatsApp's doodles. */
const ink = (percent: number) => `color-mix(in oklab, var(--foreground) ${percent}%, transparent)`;
const tint = (color: string, percent: number) =>
  `color-mix(in oklab, ${color} ${percent}%, var(--background))`;

const svg = (body: string, size: number) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'>${body}</svg>`,
  )}")`;

/** Chat bubbles, stars, and squiggles; drawn through a mask so it takes the theme's ink. */
const DOODLES = svg(
  [
    "<path d='M14 18h20a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H24l-6 5v-5h-4a4 4 0 0 1-4-4V22a4 4 0 0 1 4-4z'/>",
    "<path d='M78 14l2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.5-.8z'/>",
    "<circle cx='104' cy='60' r='7'/>",
    "<path d='M60 84c4-6 8 6 12 0s8 6 12 0'/>",
    "<path d='M22 92l8 8m0-8l-8 8'/>",
    "<rect x='92' y='96' width='14' height='14' rx='3'/>",
    "<path d='M46 50a6 6 0 1 1 12 0c0 6-6 6-6 12'/>",
  ].join(""),
  120,
);

export interface BotWallpaperPreset {
  readonly id: string;
  readonly label: string;
  /** Painted behind the messages; `mask` layers draw the theme's ink through a shape. */
  readonly style: CSSProperties;
}

export const BOT_WALLPAPER_PRESETS: ReadonlyArray<BotWallpaperPreset> = [
  {
    id: "doodles",
    label: "Doodles",
    style: {
      backgroundColor: ink(9),
      maskImage: DOODLES,
      maskSize: "120px 120px",
    },
  },
  {
    id: "dots",
    label: "Dots",
    style: {
      backgroundImage: `radial-gradient(${ink(14)} 1px, transparent 1.5px)`,
      backgroundSize: "18px 18px",
    },
  },
  {
    id: "grid",
    label: "Grid",
    style: {
      backgroundImage: `linear-gradient(${ink(7)} 1px, transparent 1px), linear-gradient(90deg, ${ink(7)} 1px, transparent 1px)`,
      backgroundSize: "28px 28px",
    },
  },
  {
    id: "stripes",
    label: "Stripes",
    style: {
      backgroundImage: `repeating-linear-gradient(135deg, ${ink(5)} 0 2px, transparent 2px 14px)`,
    },
  },
  {
    id: "aurora",
    label: "Aurora",
    style: {
      backgroundImage: `radial-gradient(60% 50% at 15% 10%, ${tint("#8b5cf6", 22)}, transparent), radial-gradient(55% 45% at 85% 30%, ${tint("#14b8a6", 20)}, transparent), radial-gradient(60% 55% at 50% 100%, ${tint("#3b82f6", 18)}, transparent)`,
    },
  },
  {
    id: "sunset",
    label: "Sunset",
    style: {
      backgroundImage: `linear-gradient(180deg, ${tint("#f97316", 16)}, ${tint("#ec4899", 14)} 60%, ${tint("#8b5cf6", 12)})`,
    },
  },
  {
    id: "ocean",
    label: "Ocean",
    style: {
      backgroundImage: `linear-gradient(160deg, ${tint("#0ea5e9", 18)}, ${tint("#1e3a8a", 14)})`,
    },
  },
  {
    id: "forest",
    label: "Forest",
    style: {
      backgroundImage: `linear-gradient(160deg, ${tint("#22c55e", 16)}, ${tint("#065f46", 14)})`,
    },
  },
];

/** WhatsApp-style solid colors; mixed into the theme background when shown. */
export const BOT_WALLPAPER_COLORS: ReadonlyArray<string> = [
  "#e8d5b5",
  "#f4c2c2",
  "#c9e4ca",
  "#bcd8f0",
  "#d7c6f2",
  "#f6e7a1",
  "#9fb8ad",
  "#5b6c8f",
];

/** How strongly a solid color covers the theme background, so text stays legible. */
const COLOR_STRENGTH = 35;

/**
 * The layer's style for a wallpaper that needs no download, or null for none
 * (including a preset this build does not know). Photos are drawn from their
 * URL by the caller.
 */
export function botWallpaperStyle(
  wallpaper: Exclude<BotWallpaper, { kind: "photo" }> | null | undefined,
): CSSProperties | null {
  if (wallpaper == null) return null;
  if (wallpaper.kind === "color") return { backgroundColor: tint(wallpaper.color, COLOR_STRENGTH) };
  return BOT_WALLPAPER_PRESETS.find((preset) => preset.id === wallpaper.id)?.style ?? null;
}
