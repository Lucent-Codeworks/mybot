// @effect-diagnostics nodeBuiltinImport:off -- Fixtures are laid out synchronously, including a symlink, before the service reads them.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { type PetError, PetId, ProviderInstanceId } from "@mybot/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PetLibrary from "./PetLibrary.ts";
import { decodePng, encodePng } from "./png.ts";

const codexInstanceId = ProviderInstanceId.make("codex");

/** A blank RGBA PNG of the given size. */
const blankPng = (width: number, height: number) =>
  encodePng({ width, height, channels: 4, data: new Uint8Array(width * height * 4) });

interface Harness {
  readonly pets: PetLibrary.PetLibrary["Service"];
  readonly settings: ServerSettings.ServerSettingsService["Service"];
  readonly config: ServerConfig.ServerConfig["Service"];
  readonly codexHome: string;
  /** Saves bytes as an uploaded attachment and returns its id. */
  readonly upload: (name: string, bytes: Uint8Array) => string;
  /** Writes a Codex pet folder at `<codexHome>/pets/<folder>`. */
  readonly codexPet: (
    folder: string,
    manifest: Record<string, unknown>,
    files?: Record<string, Uint8Array>,
  ) => string;
}

const withPets = <A, E>(
  run: (harness: Harness) => Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const codexHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pets-codex-" });
    const layer = PetLibrary.layer.pipe(
      Layer.provideMerge(
        ServerSettings.layerTest({
          providerInstances: {
            [codexInstanceId]: { driver: "codex", config: { homePath: codexHome } },
          },
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pets-library-" })),
    );
    return yield* Effect.gen(function* () {
      const pets = yield* PetLibrary.PetLibrary;
      const settings = yield* ServerSettings.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const upload = (name: string, bytes: Uint8Array) => {
        NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `${name}.png`), bytes);
        return name;
      };
      const codexPet: Harness["codexPet"] = (folder, manifest, files = {}) => {
        const dir = NodePath.join(codexHome, "pets", folder);
        NodeFS.mkdirSync(dir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(dir, "pet.json"), JSON.stringify(manifest));
        for (const [name, bytes] of Object.entries(files)) {
          NodeFS.writeFileSync(NodePath.join(dir, name), bytes);
        }
        return dir;
      };
      return yield* run({ pets, settings, config, codexHome, upload, codexPet });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

/** A lossless WebP header of the given size; enough for the size check, not a real image. */
const webpHeader = (width: number, height: number) => {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBPVP8L", 8, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes[20] = 0x2f;
  bytes.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return new Uint8Array(bytes);
};

const failure = <A>(effect: Effect.Effect<A, PetError>) =>
  Effect.flip(effect).pipe(Effect.map((error) => ({ code: error.code, message: error.message })));

it.effect("imports an uploaded atlas as a stored pet", () =>
  withPets(({ pets, config, upload }) =>
    Effect.gen(function* () {
      const attachmentId = upload("pet-upload-1", blankPng(1536, 1872));

      const pet = yield* pets.importUpload({
        attachmentId,
        displayName: "Mochi",
        description: "A sleepy cat.",
      });

      expect(pet).toMatchObject({
        id: "mochi",
        displayName: "Mochi",
        kind: "atlas",
        atlasVersion: 1,
        source: "import",
        builtIn: false,
      });
      const folder = NodePath.join(config.petsDir, "mochi");
      expect(NodeFS.readdirSync(folder).toSorted()).toEqual(["pet.json", "spritesheet.png"]);
      expect(
        JSON.parse(NodeFS.readFileSync(NodePath.join(folder, "pet.json"), "utf8")),
      ).toMatchObject({ id: "mochi", displayName: "Mochi", spritesheetPath: "spritesheet.png" });
      const listed = yield* pets.list();
      expect(listed.map((entry) => entry.id)).toEqual([
        "builtin-bolt",
        "builtin-ember",
        "builtin-pip",
        "mochi",
      ]);
      expect(listed.at(-1)).toMatchObject({ atlasVersion: 1, kind: "atlas" });
      // Only finished pets are listed; the hatch scratch folder is not one.
      NodeFS.mkdirSync(NodePath.join(config.petsDir, ".hatch", "job-1"), { recursive: true });
      expect((yield* pets.list()).length).toBe(4);
    }),
  ),
);

it.effect("rejects an upload that is not a pet atlas and leaves the library untouched", () =>
  withPets(({ pets, config, upload }) =>
    Effect.gen(function* () {
      const before = NodeFS.readdirSync(config.petsDir);
      const attachmentId = upload("pet-upload-square", blankPng(1024, 1024));

      const error = yield* failure(
        pets.importUpload({ attachmentId, displayName: "Square", description: "" }),
      );

      expect(error.code).toBe("invalid_image");
      expect(error.message).toContain("1536×1872");
      expect(NodeFS.readdirSync(config.petsDir)).toEqual(before);
    }),
  ),
);

it.effect("gives pets with the same name distinct ids", () =>
  withPets(({ pets }) =>
    Effect.gen(function* () {
      const bytes = blankPng(1536, 2288);
      const first = yield* pets.importAtlasBytes({
        bytes,
        displayName: "Bolt",
        description: "",
        source: "hatched",
      });
      const second = yield* pets.importAtlasBytes({
        bytes,
        displayName: "Bolt",
        description: "",
        source: "hatched",
      });

      expect([first.id, second.id]).toEqual(["bolt", "bolt-2"]);
      expect(second).toMatchObject({ atlasVersion: 2, source: "hatched" });
    }),
  ),
);

it.effect("finds and copies in a pet from a Codex install", () =>
  withPets(({ pets, codexPet }) =>
    Effect.gen(function* () {
      const folder = codexPet(
        "mochi",
        {
          id: "mochi",
          displayName: "Mochi",
          description: "A sleepy cat.",
          spritesheetPath: "spritesheet.png",
          spriteVersionNumber: 1,
        },
        { "spritesheet.png": blankPng(1536, 1872) },
      );

      expect(yield* pets.listCodexCandidates()).toEqual([
        {
          providerInstanceId: codexInstanceId,
          folderName: "mochi",
          displayName: "Mochi",
          description: "A sleepy cat.",
        },
      ]);

      const pet = yield* pets.importCodex({
        providerInstanceId: codexInstanceId,
        folderName: "mochi",
      });
      expect(pet).toMatchObject({ id: "mochi", source: "codex", kind: "atlas", atlasVersion: 1 });

      NodeFS.rmSync(folder, { recursive: true, force: true });
      expect((yield* pets.list()).map((entry) => entry.id)).toContain("mochi");
      const sprite = yield* pets.resolveSprite(PetId.make("mochi"));
      expect(sprite).toMatchObject({ kind: "file", mimeType: "image/png" });
      if (sprite.kind === "file") expect(NodeFS.lstatSync(sprite.path).isFile()).toBe(true);
    }),
  ),
);

it.effect("refuses a Codex pet whose sprite sheet lies outside its folder", () =>
  withPets(({ pets, codexHome, codexPet }) =>
    Effect.gen(function* () {
      const outside = NodePath.join(codexHome, "x.png");
      NodeFS.writeFileSync(outside, blankPng(1536, 1872));
      codexPet("escape", {
        id: "escape",
        displayName: "Escape",
        description: "",
        spritesheetPath: "../../x.png",
      });
      const linked = codexPet("linked", {
        id: "linked",
        displayName: "Linked",
        description: "",
        spritesheetPath: "spritesheet.png",
      });
      NodeFS.symlinkSync(outside, NodePath.join(linked, "spritesheet.png"));
      const absolute = codexPet("absolute", {
        id: "absolute",
        displayName: "Absolute",
        description: "",
        spritesheetPath: outside,
      });
      expect(absolute).toBeTruthy();

      for (const folderName of ["escape", "linked", "absolute"]) {
        const error = yield* failure(
          pets.importCodex({ providerInstanceId: codexInstanceId, folderName }),
        );
        expect(error.code).toBe("invalid_manifest");
      }
    }),
  ),
);

it.effect("removing the default pet clears the default", () =>
  withPets(({ pets, settings }) =>
    Effect.gen(function* () {
      const pet = yield* pets.importAtlasBytes({
        bytes: blankPng(1536, 1872),
        displayName: "Mochi",
        description: "",
        source: "import",
      });
      yield* settings.updateSettings({ defaultPetId: pet.id });

      yield* pets.remove({ petId: pet.id });

      expect((yield* settings.getSettings).defaultPetId).toBeNull();
      expect((yield* pets.list()).map((entry) => entry.id)).not.toContain(pet.id);
    }),
  ),
);

it.effect("built-in pets are read-only pictures rendered as PNG", () =>
  withPets(({ pets }) =>
    Effect.gen(function* () {
      const bolt = PetId.make("builtin-bolt");
      expect((yield* failure(pets.remove({ petId: bolt }))).code).toBe("read_only");
      expect((yield* failure(pets.rename({ petId: bolt, displayName: "Volt" }))).code).toBe(
        "read_only",
      );

      const sprite = yield* pets.resolveSprite(bolt);
      expect(sprite.kind).toBe("bytes");
      if (sprite.kind === "bytes") {
        expect(sprite.mimeType).toBe("image/png");
        expect(decodePng(sprite.bytes)).toMatchObject({ width: 16, height: 16 });
      }
      expect((yield* pets.list())[0]).toMatchObject({
        id: "builtin-bolt",
        kind: "picture",
        builtIn: true,
        source: "builtin",
      });
    }),
  ),
);

it.effect("renames a stored pet and keeps its id", () =>
  withPets(({ pets }) =>
    Effect.gen(function* () {
      const pet = yield* pets.importAtlasBytes({
        bytes: blankPng(1536, 1872),
        displayName: "Mochi",
        description: "",
        source: "import",
      });

      const renamed = yield* pets.rename({ petId: pet.id, displayName: "Mochi the Great" });

      expect(renamed).toMatchObject({ id: "mochi", displayName: "Mochi the Great" });
      expect((yield* pets.list()).at(-1)?.displayName).toBe("Mochi the Great");
    }),
  ),
);

it.effect("turns any supported image into a picture pet", () =>
  withPets(({ pets, upload }) =>
    Effect.gen(function* () {
      const attachmentId = upload("pet-picture-1", blankPng(300, 200));

      const pet = yield* pets.createPicture({ attachmentId, displayName: "Selfie" });

      expect(pet).toMatchObject({ id: "selfie", kind: "picture", source: "picture" });
      expect(pet.atlasVersion).toBeUndefined();
      expect(yield* pets.resolveSprite(pet.id)).toMatchObject({
        kind: "file",
        mimeType: "image/png",
      });
      const notImage = upload("pet-picture-2", new TextEncoder().encode("not an image"));
      expect(
        (yield* failure(pets.createPicture({ attachmentId: notImage, displayName: "Text" }))).code,
      ).toBe("invalid_image");
    }),
  ),
);

it.effect("imports a Codex pet whose pet.json leaves out the sprite sheet path", () =>
  withPets(({ pets, codexPet }) =>
    Effect.gen(function* () {
      codexPet(
        "noodle",
        { id: "noodle", displayName: "Noodle", description: "" },
        { "spritesheet.webp": webpHeader(1536, 1872) },
      );

      expect((yield* pets.listCodexCandidates()).map((entry) => entry.folderName)).toEqual([
        "noodle",
      ]);
      const pet = yield* pets.importCodex({
        providerInstanceId: codexInstanceId,
        folderName: "noodle",
      });
      expect(pet).toMatchObject({ id: "noodle", atlasVersion: 1 });
      expect(yield* pets.resolveSprite(pet.id)).toMatchObject({ mimeType: "image/webp" });
      expect(
        (yield* failure(pets.importCodex({ providerInstanceId: codexInstanceId, folderName: "" })))
          .code,
      ).toBe("invalid_manifest");
    }),
  ),
);

it.effect("rejects a picture whose header is valid but has no readable size", () =>
  withPets(({ pets, upload }) =>
    Effect.gen(function* () {
      const truncated = upload(
        "pet-picture-truncated",
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
      );

      const error = yield* failure(
        pets.createPicture({ attachmentId: truncated, displayName: "Broken" }),
      );

      expect(error.code).toBe("invalid_image");
    }),
  ),
);
