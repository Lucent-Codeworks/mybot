import { PET_ATLAS, type Pet } from "@mybot/contracts";
import JSZip from "jszip";

/** Draws a picture into the first cell of every v1 atlas row, fitted and centered. */
async function pictureAtlas(picture: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(picture);
  const { cellWidth, cellHeight, v1 } = PET_ATLAS;
  const canvas = document.createElement("canvas");
  canvas.width = v1.width;
  canvas.height = v1.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot draw the pet's spritesheet.");
  const scale = Math.min(cellWidth / bitmap.width, cellHeight / bitmap.height);
  const width = bitmap.width * scale;
  const height = bitmap.height * scale;
  for (let row = 0; row < v1.rows; row += 1) {
    context.drawImage(
      bitmap,
      (cellWidth - width) / 2,
      row * cellHeight + (cellHeight - height) / 2,
      width,
      height,
    );
  }
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The spritesheet could not be drawn."))),
      "image/png",
    ),
  );
}

/**
 * A zip of the pet in the ChatGPT and Codex format: `<id>/pet.json` and its
 * spritesheet. Picture pets become a v1 atlas so those apps accept them.
 */
export async function exportPet(pet: Pet, spriteUrl: string): Promise<Blob> {
  const response = await fetch(spriteUrl);
  if (!response.ok) throw new Error("The pet's image could not be downloaded.");
  const image = await response.blob();
  const sprite = pet.kind === "picture" ? await pictureAtlas(image) : image;
  const extension = sprite.type === "image/webp" ? "webp" : "png";
  const spritesheetPath = `spritesheet.${extension}`;
  const zip = new JSZip();
  const folder = zip.folder(pet.id)!;
  folder.file(
    "pet.json",
    `${JSON.stringify(
      {
        id: pet.id,
        displayName: pet.displayName,
        description: pet.description,
        spritesheetPath,
      },
      null,
      2,
    )}\n`,
  );
  folder.file(spritesheetPath, sprite);
  return zip.generateAsync({ type: "blob", mimeType: "application/zip" });
}

/** Saves the pet's export zip through the browser's download. */
export async function downloadPetExport(pet: Pet, spriteUrl: string): Promise<void> {
  const blob = await exportPet(pet, spriteUrl);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${pet.id}.zip`;
  anchor.click();
  // Revoking synchronously can abort the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
