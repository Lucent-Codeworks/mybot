/**
 * The pets this server owns: built-in pets defined in code, plus pets the user
 * imported, made from a picture, or hatched, each stored as a folder in the
 * Codex pet format under `petsDir`. Imports always copy bytes in, so a pet never
 * changes because a file elsewhere did.
 */
import {
  type CodexPetCandidate,
  CodexSettings,
  defaultInstanceIdForDriver,
  type Pet,
  Pet as PetSchema,
  PET_DESCRIPTION_MAX_LENGTH,
  PET_DISPLAY_NAME_MAX_LENGTH,
  PetError,
  type PetErrorCode,
  PetId,
  type PetKind,
  type PetRemoveInput,
  type PetRenameInput,
  PetSource,
  petAtlasVersionForSize,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
  type ProviderInstanceId,
  resolveProviderInstanceEnabled,
} from "@mybot/contracts";
import { readImageDimensions } from "@mybot/shared/imageDimensions";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BUILT_IN_PETS } from "./builtInPets.ts";
import { encodePng } from "./png.ts";

const MANIFEST = "pet.json";
/** Versions built-in sprite URLs; move it when the rendered art changes. */
const BUILT_IN_UPDATED_AT = "2026-10-20T00:00:00.000Z";
const NOT_AN_ATLAS_MESSAGE =
  "This isn't a pet sprite sheet. Pet sheets are 1536×1872 or 1536×2288. To use any image, choose Use a picture.";

type ImageMimeType = "image/png" | "image/webp" | "image/jpeg" | "image/gif";
const EXTENSION_BY_MIME: Record<ImageMimeType, string> = {
  "image/png": "png",
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/gif": "gif",
};
const MIME_BY_EXTENSION: Record<string, ImageMimeType> = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};
const ATLAS_MIME_TYPES: ReadonlySet<ImageMimeType> = new Set(["image/png", "image/webp"]);

/** The image type the bytes start with, by magic number rather than file name. */
function sniffImageType(bytes: Uint8Array): ImageMimeType | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  return null;
}

/** A folder-safe id from a display name; ids starting `builtin-` are reserved. */
function slugify(displayName: string): string {
  const slug = displayName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // Leaves room for a `-N` suffix inside the 64-character id limit.
    .slice(0, 56)
    .replace(/-+$/, "");
  if (slug.length === 0) return "pet";
  return slug.startsWith("builtin-") ? `pet-${slug}` : slug;
}

const clamp = (value: string, max: number) => value.trim().slice(0, max).trim();

/** The fields MyBot reads from a Codex `pet.json`; anything else is ignored. */
const CodexManifest = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  // Codex finds a pet's sheet by its default name when the manifest leaves this out.
  spritesheetPath: Schema.optional(Schema.String),
});
const DEFAULT_CODEX_SPRITESHEETS = ["spritesheet.webp", "spritesheet.png"];
const decodeCodexManifest = Schema.decodeUnknownOption(Schema.fromJsonString(CodexManifest));

/** What MyBot writes to a stored pet's `pet.json`, a superset of the Codex format. */
const StoredManifest = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  description: Schema.String,
  spritesheetPath: Schema.String,
  kind: Schema.Literals(["atlas", "picture"]),
  source: PetSource,
  spriteVersionNumber: Schema.optional(Schema.Literals([1, 2])),
  updatedAt: Schema.String,
});
type StoredManifest = typeof StoredManifest.Type;
const StoredManifestJson = Schema.fromJsonString(StoredManifest);
const decodeStoredManifest = Schema.decodeUnknownOption(StoredManifestJson);
const encodeStoredManifest = Schema.encodeSync(StoredManifestJson);
const decodePet = Schema.decodeUnknownOption(PetSchema);
const isPetId = Schema.is(PetId);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

/**
 * Built-in art is scaled up by a whole number here, nearest-neighbor, so a
 * browser scaling the 192px picture to its slot keeps hard pixel edges.
 */
const BUILT_IN_SCALE = 12;

function renderBuiltIn(definition: (typeof BUILT_IN_PETS)[number]): Uint8Array {
  const height = definition.pixels.length * BUILT_IN_SCALE;
  const width = (definition.pixels[0]?.length ?? 0) * BUILT_IN_SCALE;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = definition.pixels[Math.floor(y / BUILT_IN_SCALE)] ?? "";
    for (let x = 0; x < width; x++) {
      const color = definition.palette[row[Math.floor(x / BUILT_IN_SCALE)] ?? "."];
      if (color === undefined) continue;
      const offset = (y * width + x) * 4;
      data[offset] = Number.parseInt(color.slice(1, 3), 16);
      data[offset + 1] = Number.parseInt(color.slice(3, 5), 16);
      data[offset + 2] = Number.parseInt(color.slice(5, 7), 16);
      data[offset + 3] = 255;
    }
  }
  return encodePng({ width, height, channels: 4, data });
}

type PetSprite =
  | { readonly kind: "file"; readonly path: string; readonly mimeType: string }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array; readonly mimeType: "image/png" };

export class PetLibrary extends Context.Service<
  PetLibrary,
  {
    /** Built-in pets first, then stored pets by display name. */
    readonly list: () => Effect.Effect<ReadonlyArray<Pet>>;
    /** Saves an uploaded spritesheet as an atlas pet. */
    readonly importUpload: (input: {
      readonly attachmentId: string;
      readonly displayName: string;
      readonly description: string;
    }) => Effect.Effect<Pet, PetError>;
    /** Saves spritesheet bytes as an atlas pet; used by hatching. */
    readonly importAtlasBytes: (input: {
      readonly bytes: Uint8Array;
      readonly displayName: string;
      readonly description: string;
      readonly source: PetSource;
    }) => Effect.Effect<Pet, PetError>;
    /** Pets in the `pets` folder of each enabled Codex instance's home. */
    readonly listCodexCandidates: () => Effect.Effect<ReadonlyArray<CodexPetCandidate>>;
    /** Copies one Codex pet in. */
    readonly importCodex: (input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly folderName: string;
    }) => Effect.Effect<Pet, PetError>;
    /** Saves any uploaded PNG, WebP, JPEG, or GIF as a picture pet, unresized. */
    readonly createPicture: (input: {
      readonly attachmentId: string;
      readonly displayName: string;
    }) => Effect.Effect<Pet, PetError>;
    readonly rename: (input: PetRenameInput) => Effect.Effect<Pet, PetError>;
    /** Deletes a stored pet and clears it as the default pet. */
    readonly remove: (input: PetRemoveInput) => Effect.Effect<void, PetError>;
    /** Where a pet's image is: a stored file, or in-memory bytes for a built-in pet. */
    readonly resolveSprite: (petId: PetId) => Effect.Effect<PetSprite, PetError>;
  }
>()("mybot/pets/PetLibrary") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  // Serializes writes so two pets never claim the same id.
  const writes = yield* Semaphore.make(1);

  const fail = (code: PetErrorCode, message: string) => new PetError({ code, message });
  const ioError = () => fail("io", "The pet library could not be read or written.");
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const tempName = (prefix: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => `${prefix}${uuid}`),
      Effect.mapError(ioError),
    );
  const isInside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };

  const builtIns = BUILT_IN_PETS.map((definition) => ({
    pet: {
      id: PetId.make(definition.id),
      displayName: definition.displayName,
      description: definition.description,
      kind: "picture",
      source: "builtin",
      builtIn: true,
      updatedAt: BUILT_IN_UPDATED_AT,
    } satisfies Pet,
    png: renderBuiltIn(definition),
  }));
  const builtInById = new Map(builtIns.map((entry) => [entry.pet.id as string, entry]));

  const toPet = (id: string, manifest: StoredManifest) =>
    decodePet({
      id,
      displayName: manifest.displayName,
      description: manifest.description,
      kind: manifest.kind,
      ...(manifest.kind === "atlas" && manifest.spriteVersionNumber !== undefined
        ? { atlasVersion: manifest.spriteVersionNumber }
        : {}),
      source: manifest.source,
      builtIn: false,
      updatedAt: manifest.updatedAt,
    });

  const readStored = (id: string) =>
    fileSystem.readFileString(path.join(config.petsDir, id, MANIFEST)).pipe(
      Effect.map((json) =>
        decodeStoredManifest(json).pipe(
          Option.flatMap((manifest) =>
            toPet(id, manifest).pipe(Option.map((pet) => ({ manifest, pet }))),
          ),
        ),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );

  const requireStored = (petId: PetId) =>
    Effect.gen(function* () {
      if (builtInById.has(petId))
        return yield* fail("read_only", "Built-in pets can't be renamed or removed.");
      const stored = yield* readStored(petId);
      if (Option.isNone(stored)) return yield* fail("not_found", "That pet no longer exists.");
      return stored.value;
    });

  const list: PetLibrary["Service"]["list"] = Effect.fn("PetLibrary.list")(function* () {
    const names = yield* fileSystem
      .readDirectory(config.petsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    // Dot folders are scratch space: `.hatch` jobs and half-written `.tmp-` pets.
    const ids = names.filter((name) => !name.startsWith(".") && isPetId(name));
    const stored = yield* Effect.forEach(ids, readStored, { concurrency: 8 });
    const pets = stored
      .flatMap((entry) => (Option.isSome(entry) ? [entry.value.pet] : []))
      .toSorted((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
    return [...builtIns.map((entry) => entry.pet), ...pets];
  });

  /** Writes a new pet folder atomically under a fresh id derived from its name. */
  const savePet = (input: {
    readonly displayName: string;
    readonly description: string;
    readonly kind: PetKind;
    readonly source: PetSource;
    readonly atlasVersion: 1 | 2 | undefined;
    readonly mimeType: ImageMimeType;
    readonly bytes: Uint8Array;
  }) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const displayName = clamp(input.displayName, PET_DISPLAY_NAME_MAX_LENGTH) || "Pet";
        const description = clamp(input.description, PET_DESCRIPTION_MAX_LENGTH);
        const base = slugify(displayName);
        let id = base;
        for (let suffix = 2; ; suffix++) {
          const taken = yield* fileSystem
            .exists(path.join(config.petsDir, id))
            .pipe(Effect.mapError(ioError));
          if (!taken) break;
          id = `${base}-${suffix}`;
        }
        const spriteName = `${input.kind === "atlas" ? "spritesheet" : "picture"}.${EXTENSION_BY_MIME[input.mimeType]}`;
        const manifest: StoredManifest = {
          id,
          displayName,
          description,
          spritesheetPath: spriteName,
          kind: input.kind,
          source: input.source,
          ...(input.atlasVersion !== undefined ? { spriteVersionNumber: input.atlasVersion } : {}),
          updatedAt: yield* now,
        };
        const temp = path.join(config.petsDir, yield* tempName(".tmp-"));
        yield* Effect.gen(function* () {
          yield* fileSystem.makeDirectory(temp, { recursive: true });
          yield* fileSystem.writeFile(path.join(temp, spriteName), input.bytes);
          yield* fileSystem.writeFileString(
            path.join(temp, MANIFEST),
            encodeStoredManifest(manifest),
          );
          yield* fileSystem.rename(temp, path.join(config.petsDir, id));
        }).pipe(
          Effect.onError(() =>
            fileSystem.remove(temp, { recursive: true, force: true }).pipe(Effect.ignore),
          ),
          Effect.mapError(ioError),
        );
        const pet = toPet(id, manifest);
        if (Option.isNone(pet)) return yield* ioError();
        return pet.value;
      }),
    );

  /** Reads an image file of at most the upload limit. */
  const readImageFile = (file: string) =>
    Effect.gen(function* () {
      const info = yield* fileSystem
        .stat(file)
        .pipe(Effect.mapError(() => fail("not_found", "That image could not be found.")));
      if (info.type !== "File" || Number(info.size) > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
        return yield* fail("invalid_image", "Pet images must be a file of 10 MB or less.");
      return yield* fileSystem.readFile(file).pipe(Effect.mapError(ioError));
    });

  const readAttachment = (attachmentId: string) => {
    const file = resolveAttachmentPathById({ attachmentsDir: config.attachmentsDir, attachmentId });
    return file === null
      ? Effect.fail(fail("not_found", "That upload could not be found. Try uploading it again."))
      : readImageFile(file);
  };

  const saveAtlas = (input: {
    readonly bytes: Uint8Array;
    readonly displayName: string;
    readonly description: string;
    readonly source: PetSource;
  }) =>
    Effect.gen(function* () {
      const mimeType = sniffImageType(input.bytes);
      const size = readImageDimensions(input.bytes);
      const atlasVersion = size === null ? null : petAtlasVersionForSize(size.width, size.height);
      if (mimeType === null || !ATLAS_MIME_TYPES.has(mimeType) || atlasVersion === null)
        return yield* fail("invalid_image", NOT_AN_ATLAS_MESSAGE);
      return yield* savePet({ ...input, kind: "atlas", atlasVersion, mimeType });
    });

  const importAtlasBytes: PetLibrary["Service"]["importAtlasBytes"] = Effect.fn(
    "PetLibrary.importAtlasBytes",
  )(function* (input) {
    return yield* saveAtlas(input);
  });

  const importUpload: PetLibrary["Service"]["importUpload"] = Effect.fn("PetLibrary.importUpload")(
    function* (input) {
      const bytes = yield* readAttachment(input.attachmentId);
      return yield* saveAtlas({ ...input, bytes, source: "import" });
    },
  );

  const createPicture: PetLibrary["Service"]["createPicture"] = Effect.fn(
    "PetLibrary.createPicture",
  )(function* (input) {
    const bytes = yield* readAttachment(input.attachmentId);
    const mimeType = sniffImageType(bytes);
    if (mimeType === null || readImageDimensions(bytes) === null)
      return yield* fail("invalid_image", "Pictures must be PNG, WebP, JPEG, or GIF images.");
    return yield* savePet({
      displayName: input.displayName,
      description: "",
      kind: "picture",
      source: "picture",
      atlasVersion: undefined,
      mimeType,
      bytes,
    });
  });

  /**
   * The folders each enabled Codex instance keeps pets in. An instance with a
   * shadow home has two homes, and either may hold pets.
   */
  const codexHomes = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(Effect.option);
    if (Option.isNone(settings)) return [];
    const codex = ProviderDriverKind.make("codex");
    const instances = Object.entries(settings.value.providerInstances).filter(
      ([, instance]) => instance.driver === codex && resolveProviderInstanceEnabled(instance),
    );
    const defaultId = defaultInstanceIdForDriver(codex);
    if (!Object.hasOwn(settings.value.providerInstances, defaultId))
      instances.unshift([defaultId, { driver: codex }]);
    const homes: Array<{ providerInstanceId: ProviderInstanceId; home: string }> = [];
    for (const [instanceId, instance] of instances) {
      const codexSettings = decodeCodexSettings(instance.config ?? {});
      if (Option.isNone(codexSettings)) continue;
      const layout = yield* resolveCodexHomeLayout(codexSettings.value).pipe(
        Effect.provideService(Path.Path, path),
      );
      for (const home of new Set([layout.sharedHomePath, layout.effectiveHomePath])) {
        if (home !== undefined)
          homes.push({ providerInstanceId: instanceId as ProviderInstanceId, home });
      }
    }
    return homes;
  });

  const readCodexManifest = (folder: string) =>
    fileSystem.readFileString(path.join(folder, MANIFEST)).pipe(
      Effect.map(decodeCodexManifest),
      Effect.orElseSucceed(() => Option.none()),
    );

  const codexNames = (folderName: string, manifest: typeof CodexManifest.Type) => ({
    displayName:
      clamp(manifest.displayName ?? "", PET_DISPLAY_NAME_MAX_LENGTH) ||
      clamp(folderName, PET_DISPLAY_NAME_MAX_LENGTH),
    description: clamp(manifest.description ?? "", PET_DESCRIPTION_MAX_LENGTH),
  });

  const listCodexCandidates: PetLibrary["Service"]["listCodexCandidates"] = Effect.fn(
    "PetLibrary.listCodexCandidates",
  )(function* () {
    const seenHomes = new Set<string>();
    const candidates: Array<CodexPetCandidate> = [];
    for (const { providerInstanceId, home } of yield* codexHomes) {
      if (seenHomes.has(home)) continue;
      seenHomes.add(home);
      const petsFolder = path.join(home, "pets");
      const folders = yield* fileSystem
        .readDirectory(petsFolder)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const found: Array<CodexPetCandidate> = [];
      for (const folderName of folders) {
        if (folderName.startsWith(".") || folderName.trim() !== folderName) continue;
        const manifest = yield* readCodexManifest(path.join(petsFolder, folderName));
        if (Option.isNone(manifest)) continue;
        found.push({ providerInstanceId, folderName, ...codexNames(folderName, manifest.value) });
      }
      candidates.push(...found.toSorted((a, b) => a.displayName.localeCompare(b.displayName)));
    }
    return candidates;
  });

  const importCodex: PetLibrary["Service"]["importCodex"] = Effect.fn("PetLibrary.importCodex")(
    function* (input) {
      const homes = (yield* codexHomes).filter(
        (entry) => entry.providerInstanceId === input.providerInstanceId,
      );
      if (homes.length === 0)
        return yield* fail("codex_unavailable", "That Codex install is not connected.");
      const folderName = input.folderName;
      if (folderName.trim() === "" || folderName.startsWith(".") || /[\\/]/.test(folderName))
        return yield* fail("invalid_manifest", "That isn't a Codex pet folder.");
      let found: { folder: string; manifest: typeof CodexManifest.Type } | undefined;
      for (const { home } of homes) {
        const folder = path.join(home, "pets", folderName);
        const manifest = yield* readCodexManifest(folder);
        if (Option.isSome(manifest)) {
          found = { folder, manifest: manifest.value };
          break;
        }
      }
      if (found === undefined)
        return yield* fail(
          "not_found",
          "That Codex pet no longer exists or has no valid pet.json.",
        );

      // The sheet must be a file inside the pet's own folder, even through links.
      const outside = fail(
        "invalid_manifest",
        "This pet's pet.json points to a sprite sheet outside its folder.",
      );
      const folder = found.folder;
      let spritePath = found.manifest.spritesheetPath;
      if (spritePath === undefined) {
        for (const name of DEFAULT_CODEX_SPRITESHEETS) {
          const exists = yield* fileSystem
            .exists(path.join(folder, name))
            .pipe(Effect.orElseSucceed(() => false));
          if (exists) {
            spritePath = name;
            break;
          }
        }
        if (spritePath === undefined)
          return yield* fail(
            "invalid_manifest",
            "This pet's sprite sheet is missing from its folder.",
          );
      }
      if (
        spritePath.trim() === "" ||
        path.isAbsolute(spritePath) ||
        spritePath.split(/[\\/]/).includes("..")
      )
        return yield* outside;
      const realFolder = yield* fileSystem.realPath(found.folder).pipe(Effect.mapError(ioError));
      const realSprite = yield* fileSystem
        .realPath(path.join(found.folder, spritePath))
        .pipe(
          Effect.mapError(() =>
            fail("invalid_manifest", "This pet's sprite sheet is missing from its folder."),
          ),
        );
      if (!isInside(realFolder, realSprite)) return yield* outside;

      const bytes = yield* readImageFile(realSprite);
      return yield* saveAtlas({
        bytes,
        ...codexNames(folderName, found.manifest),
        source: "codex",
      });
    },
  );

  const rename: PetLibrary["Service"]["rename"] = Effect.fn("PetLibrary.rename")(function* (input) {
    return yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const { manifest } = yield* requireStored(input.petId);
        const next: StoredManifest = {
          ...manifest,
          displayName:
            clamp(input.displayName, PET_DISPLAY_NAME_MAX_LENGTH) || manifest.displayName,
          updatedAt: yield* now,
        };
        const folder = path.join(config.petsDir, input.petId);
        const temp = path.join(folder, yield* tempName(".pet.json.tmp-"));
        yield* fileSystem.writeFileString(temp, encodeStoredManifest(next)).pipe(
          Effect.andThen(fileSystem.rename(temp, path.join(folder, MANIFEST))),
          Effect.onError(() => fileSystem.remove(temp, { force: true }).pipe(Effect.ignore)),
          Effect.mapError(ioError),
        );
        const pet = toPet(input.petId, next);
        if (Option.isNone(pet)) return yield* ioError();
        return pet.value;
      }),
    );
  });

  const remove: PetLibrary["Service"]["remove"] = Effect.fn("PetLibrary.remove")(function* (input) {
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        yield* requireStored(input.petId);
        // Moved aside first so the pet disappears at once even if deleting is slow.
        const trash = path.join(config.petsDir, yield* tempName(".tmp-"));
        yield* fileSystem
          .rename(path.join(config.petsDir, input.petId), trash)
          .pipe(Effect.mapError(ioError));
        // The pet is gone once moved aside; a leftover `.tmp-` folder is never listed.
        yield* fileSystem
          .remove(trash, { recursive: true, force: true })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not delete a removed pet's files.", cause).pipe(
                Effect.annotateLogs({ petId: input.petId }),
              ),
            ),
          );
      }),
    );
    // Bots that chose this pet keep the id; clients fall back to the default.
    const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(ioError));
    if (settings.defaultPetId === input.petId)
      yield* serverSettings.updateSettings({ defaultPetId: null }).pipe(Effect.mapError(ioError));
  });

  const resolveSprite: PetLibrary["Service"]["resolveSprite"] = Effect.fn(
    "PetLibrary.resolveSprite",
  )(function* (petId) {
    const builtIn = builtInById.get(petId);
    if (builtIn !== undefined)
      return { kind: "bytes", bytes: builtIn.png, mimeType: "image/png" } as const;
    const missing = fail("not_found", "That pet no longer exists.");
    const stored = yield* readStored(petId);
    if (Option.isNone(stored)) return yield* missing;
    const spriteName = stored.value.manifest.spritesheetPath;
    const mimeType = MIME_BY_EXTENSION[path.extname(spriteName).slice(1).toLowerCase()];
    if (path.basename(spriteName) !== spriteName || spriteName.startsWith(".") || !mimeType)
      return yield* missing;
    const file = path.join(config.petsDir, petId, spriteName);
    const exists = yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return yield* missing;
    return { kind: "file", path: file, mimeType } as const;
  });

  return PetLibrary.of({
    list,
    importUpload,
    importAtlasBytes,
    listCodexCandidates,
    importCodex,
    createPicture,
    rename,
    remove,
    resolveSprite,
  });
});

export const layer = Layer.effect(PetLibrary, make);
