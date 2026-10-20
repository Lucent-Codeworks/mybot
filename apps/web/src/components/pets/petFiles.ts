import { PET_DESCRIPTION_MAX_LENGTH, PET_DISPLAY_NAME_MAX_LENGTH } from "@mybot/contracts";
import JSZip from "jszip";

/** A file choice the import cannot use. The message is written for the user. */
export class PetFileError extends Error {
  override readonly name = "PetFileError";
}

export interface ParsedPetFiles {
  readonly image: File;
  readonly displayName: string;
  readonly description: string;
}

/** The existing image attachment limit; the server enforces it too. */
export const PET_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;

const ATLAS_TYPES: Readonly<Record<string, string>> = { png: "image/png", webp: "image/webp" };
const PICTURE_TYPES: Readonly<Record<string, string>> = {
  ...ATLAS_TYPES,
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A display name from a file name: no extension, trimmed to the name limit. */
function nameFromFile(name: string): string {
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name).trim();
  return stem.slice(0, PET_DISPLAY_NAME_MAX_LENGTH).trim() || "Pet";
}

function checkSize(file: File) {
  if (file.size > PET_UPLOAD_MAX_BYTES) {
    throw new PetFileError(`${file.name} is over 10 MB.`);
  }
}

function isZip(file: File) {
  return extensionOf(file.name) === "zip" || file.type === "application/zip";
}

function isUnsafePath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith("/") || normalized.split("/").includes("..");
}

interface Manifest {
  readonly displayName: string;
  readonly description: string;
  /** Null when the manifest names no sprite; the standard names are tried. */
  readonly spritesheetPath: string | null;
}

function parseManifest(text: string, byteLength: number): Manifest {
  if (byteLength > MANIFEST_MAX_BYTES) throw new PetFileError("pet.json is over 64 KB.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PetFileError("pet.json is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PetFileError("pet.json is not a pet manifest.");
  }
  const record = value as Record<string, unknown>;
  const displayName = typeof record.displayName === "string" ? record.displayName.trim() : "";
  if (!displayName) throw new PetFileError("pet.json has no displayName.");
  if (displayName.length > PET_DISPLAY_NAME_MAX_LENGTH) {
    throw new PetFileError(
      `The pet's name is over ${PET_DISPLAY_NAME_MAX_LENGTH} characters. Shorten displayName in pet.json.`,
    );
  }
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (description.length > PET_DESCRIPTION_MAX_LENGTH) {
    throw new PetFileError(
      `The pet's description is over ${PET_DESCRIPTION_MAX_LENGTH} characters. Shorten it in pet.json.`,
    );
  }
  const spritesheetPath =
    typeof record.spritesheetPath === "string" && record.spritesheetPath.trim()
      ? record.spritesheetPath.trim().replaceAll("\\", "/")
      : null;
  if (spritesheetPath !== null && isUnsafePath(spritesheetPath)) {
    throw new PetFileError("pet.json points its spritesheet outside the pet's folder.");
  }
  return { displayName, description, spritesheetPath };
}

const STANDARD_SPRITE_NAMES = ["spritesheet.webp", "spritesheet.png"];

function spriteCandidates(manifest: Manifest): ReadonlyArray<string> {
  return manifest.spritesheetPath === null ? STANDARD_SPRITE_NAMES : [manifest.spritesheetPath];
}

function missingSprite(manifest: Manifest) {
  return new PetFileError(
    `pet.json names ${manifest.spritesheetPath ?? "spritesheet.webp"}, but that file isn't here. Choose it along with pet.json.`,
  );
}

function atlasFile(bytes: BlobPart, path: string): File {
  const name = baseName(path);
  const type = ATLAS_TYPES[extensionOf(name)];
  if (!type) throw new PetFileError("Spritesheets must be PNG or WebP images.");
  return new File([bytes], name, { type });
}

async function parseZip(zipFile: File): Promise<ParsedPetFiles> {
  checkSize(zipFile);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await zipFile.arrayBuffer());
  } catch {
    throw new PetFileError(`${zipFile.name} is not a zip file.`);
  }
  const entries = new Map<string, JSZip.JSZipObject>();
  for (const entry of Object.values(zip.files)) {
    // JSZip resolves `..` in `name`; the original is what the archive says.
    const original = (entry as { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    if (isUnsafePath(original)) {
      throw new PetFileError(`${zipFile.name} has files outside its folder, so it wasn't opened.`);
    }
    if (entry.dir || original.startsWith("__MACOSX/") || baseName(original) === ".DS_Store") {
      continue;
    }
    entries.set(original, entry);
  }
  const manifestPaths = [...entries.keys()].filter(
    (path) => path === "pet.json" || /^[^/]+\/pet\.json$/.test(path),
  );
  if (manifestPaths.length !== 1) {
    throw new PetFileError(
      manifestPaths.length === 0
        ? `${zipFile.name} has no pet.json at its top level.`
        : `${zipFile.name} has more than one pet. Zip one pet at a time.`,
    );
  }
  const manifestPath = manifestPaths[0]!;
  const folder = manifestPath.slice(0, manifestPath.length - "pet.json".length);
  const manifestBytes = await entries.get(manifestPath)!.async("uint8array");
  const manifest = parseManifest(new TextDecoder().decode(manifestBytes), manifestBytes.byteLength);
  for (const candidate of spriteCandidates(manifest)) {
    const entry = entries.get(`${folder}${candidate}`);
    if (!entry) continue;
    const bytes = await entry.async("arraybuffer");
    if (bytes.byteLength > PET_UPLOAD_MAX_BYTES) {
      throw new PetFileError("The spritesheet is over 10 MB.");
    }
    return { ...manifest, image: atlasFile(bytes, candidate) };
  }
  throw missingSprite(manifest);
}

/**
 * Turns a pet chosen in the browser into the spritesheet and manifest fields
 * to upload: a single PNG or WebP spritesheet, a `pet.json` with the image it
 * names, or one `.zip` of both. Throws `PetFileError` with a message for the
 * user. Spritesheet dimensions are checked by the server.
 */
export async function parsePetFiles(files: ReadonlyArray<File>): Promise<ParsedPetFiles> {
  if (files.length === 0) throw new PetFileError("Choose a pet to import.");
  if (files.length === 1 && isZip(files[0]!)) return parseZip(files[0]!);
  const manifestFile = files.find((file) => file.name.toLowerCase() === "pet.json");
  if (!manifestFile) {
    if (files.length !== 1) {
      throw new PetFileError("Choose pet.json with its spritesheet, a .zip, or one spritesheet.");
    }
    const image = files[0]!;
    checkSize(image);
    return {
      image: atlasFile(image, image.name),
      displayName: nameFromFile(image.name),
      description: "",
    };
  }
  const manifest = parseManifest(await manifestFile.text(), manifestFile.size);
  // A browser file choice has no folders, so only the sprite's file name counts.
  const names = new Set(spriteCandidates(manifest).map((path) => baseName(path).toLowerCase()));
  const image = files.find((file) => file !== manifestFile && names.has(file.name.toLowerCase()));
  if (!image) throw missingSprite(manifest);
  checkSize(image);
  return { ...manifest, image: atlasFile(image, image.name) };
}

/** A picture pet's image and the name it starts with. */
export function parsePictureFile(file: File): { image: File; displayName: string } {
  checkSize(file);
  const type = PICTURE_TYPES[extensionOf(file.name)] ?? file.type;
  if (!Object.values(PICTURE_TYPES).includes(type)) {
    throw new PetFileError("Pictures must be PNG, WebP, JPEG, or GIF images.");
  }
  return {
    image: file.type === type ? file : new File([file], file.name, { type }),
    displayName: nameFromFile(file.name),
  };
}
