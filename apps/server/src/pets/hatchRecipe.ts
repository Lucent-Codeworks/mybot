/**
 * The prompt a hatching thread sends to Codex. Codex only draws; the server
 * slices the strips into the atlas (see atlas.ts), so no scripts or Python are
 * needed on the user's machine.
 *
 * The row descriptions are adapted from OpenAI's hatch-pet skill
 * (github.com/openai/skills, skills/.curated/hatch-pet/references/animation-rows.md),
 * licensed under Apache-2.0.
 */
import { PET_ROWS, type PetRowName } from "@mybot/contracts";

/** The server mirrors running-right for running-left, so Codex never draws it. */
export const HATCH_STRIP_ROWS = PET_ROWS.filter((row) => row.name !== "running-left");

const ROW_DESCRIPTIONS: Record<Exclude<PetRowName, "running-left">, string> = {
  idle: "a calm breathing or blinking loop; keep the motion subtle",
  "running-right": "running to the right; the loop should clearly read as moving right",
  waving: "a greeting: a clear start, the raised wave, and the return",
  jumping: "anticipation, lift, peak, descent, settle",
  failed: "a sad, deflated reaction; readable but not noisy",
  waiting: "an expectant pose, asking the user for input or approval",
  running:
    "focused work: thinking, typing, or concentrating. Not foot-running, and no travel across the strip",
  review: "a focused inspecting or thinking loop",
};

export function buildHatchPrompt(input: {
  readonly displayName: string;
  readonly description: string;
  readonly jobDir: string;
  readonly hasReference: boolean;
}): string {
  const stripsDir = `${input.jobDir}/strips`;
  const rows = HATCH_STRIP_ROWS.map(
    ({ name, frameDurationsMs }) =>
      `- ${name} (${frameDurationsMs.length} frames): ${ROW_DESCRIPTIONS[name as keyof typeof ROW_DESCRIPTIONS]}`,
  );
  return [
    `Draw a small animated pet named "${input.displayName}" for MyBot.`,
    input.description.trim() === "" ? null : `The character: ${input.description.trim()}`,
    input.hasReference ? "Base its look on the attached reference image." : null,
    "",
    "Use your built-in image generation for every image. Don't write scripts or draw images any other way.",
    "",
    "1. Generate one base image of the character: a compact, whole-body pose that still reads at 192x208 pixels.",
    "2. Using that base image as the reference, generate one horizontal strip per state below. Each strip shows its frames left to right, evenly spaced and not touching, at the same size.",
    "   Every image: one consistent character (same face, colors, proportions, and props), a flat #00FF00 background, and no text, labels, shadows, or scenery.",
    ...rows.map((row) => `   ${row}`),
    `3. Save each strip by copying the generated PNG file (from $CODEX_HOME/generated_images, usually ~/.codex/generated_images) to ${stripsDir}/<state>.png, for example ${stripsDir}/idle.png.`,
    "   Don't paste images into the chat.",
    '4. When every strip is saved, reply "done".',
  ]
    .filter((line) => line !== null)
    .join("\n");
}
