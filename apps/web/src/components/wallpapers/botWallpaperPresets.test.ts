import { describe, expect, it } from "vite-plus/test";

import { BOT_WALLPAPER_PRESETS, botWallpaperStyle } from "./botWallpaperPresets";

describe("botWallpaperStyle", () => {
  it("shows nothing for no wallpaper or a preset this build does not know", () => {
    expect(botWallpaperStyle(null)).toBeNull();
    expect(botWallpaperStyle(undefined)).toBeNull();
    expect(botWallpaperStyle({ kind: "preset", id: "from-a-newer-build" })).toBeNull();
  });

  it("mixes a solid color into the theme background so text stays legible", () => {
    expect(botWallpaperStyle({ kind: "color", color: "#bcd8f0" })).toEqual({
      backgroundColor: "color-mix(in oklab, #bcd8f0 35%, var(--background))",
    });
  });

  it("has a unique id per preset", () => {
    const ids = BOT_WALLPAPER_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(botWallpaperStyle({ kind: "preset", id })).not.toBeNull();
  });
});
