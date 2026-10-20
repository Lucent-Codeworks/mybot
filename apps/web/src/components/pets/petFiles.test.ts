import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";

import { parsePetFiles, PetFileError } from "./petFiles";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function zipFile(name: string, entries: Record<string, string | Uint8Array>) {
  const zip = new JSZip();
  for (const [path, contents] of Object.entries(entries)) zip.file(path, contents);
  const bytes = await zip.generateAsync({ type: "arraybuffer" });
  return new File([bytes], name, { type: "application/zip" });
}

function manifest(fields: Record<string, unknown>) {
  return JSON.stringify({ id: "mochi", spritesheetPath: "spritesheet.webp", ...fields });
}

describe("parsePetFiles", () => {
  it("names a single spritesheet after its file", async () => {
    const parsed = await parsePetFiles([new File([PNG_BYTES], "Bolt.png", { type: "image/png" })]);
    expect(parsed.displayName).toBe("Bolt");
    expect(parsed.description).toBe("");
    expect(parsed.image.type).toBe("image/png");
  });

  it("reads the manifest and sprite from a zip's top-level folder", async () => {
    const file = await zipFile("mochi.zip", {
      "mochi/pet.json": manifest({ displayName: "Mochi", description: "A round cat" }),
      "mochi/spritesheet.webp": PNG_BYTES,
    });
    const parsed = await parsePetFiles([file]);
    expect(parsed).toMatchObject({ displayName: "Mochi", description: "A round cat" });
    expect(parsed.image.name).toBe("spritesheet.webp");
    expect(parsed.image.type).toBe("image/webp");
    expect(new Uint8Array(await parsed.image.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("rejects a zip with an entry that climbs out of the folder", async () => {
    const file = await zipFile("evil.zip", {
      "pet.json": manifest({ displayName: "Evil" }),
      "spritesheet.webp": PNG_BYTES,
      "../evil.png": PNG_BYTES,
    });
    const parsing = parsePetFiles([file]);
    await expect(parsing).rejects.toBeInstanceOf(PetFileError);
    await expect(parsing).rejects.toThrow(/outside its folder/);
  });

  it("rejects a manifest whose name is over 40 characters", async () => {
    const json = new File([manifest({ displayName: "x".repeat(41) })], "pet.json", {
      type: "application/json",
    });
    const sprite = new File([PNG_BYTES], "spritesheet.webp", { type: "image/webp" });
    await expect(parsePetFiles([json, sprite])).rejects.toThrow(/40 characters/);
  });

  it("rejects a manifest whose sprite was not chosen", async () => {
    const json = new File([manifest({ displayName: "Mochi" })], "pet.json", {
      type: "application/json",
    });
    const other = new File([PNG_BYTES], "other.png", { type: "image/png" });
    await expect(parsePetFiles([json, other])).rejects.toThrow(/spritesheet\.webp/);
  });
});
