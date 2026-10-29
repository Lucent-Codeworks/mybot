/**
 * BotWallpapers - the photos users pick as a bot's chat wallpaper.
 *
 * A photo is copied out of its upload into `wallpapersDir` under the SHA-256
 * of its bytes, so the id is also its file name, the same photo is stored
 * once, and the asset URL that serves it can be cached for good.
 *
 * @module BotWallpapers
 */
import {
  BotWallpaperError,
  BotWallpaperPhotoId,
  type BotWallpaperSavePhotoInput,
  type BotWallpaperSavePhotoResult,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@mybot/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { sniffImageType } from "../pets/PetLibrary.ts";

export class BotWallpapers extends Context.Service<
  BotWallpapers,
  {
    readonly savePhoto: (
      input: BotWallpaperSavePhotoInput,
    ) => Effect.Effect<BotWallpaperSavePhotoResult, BotWallpaperError>;
  }
>()("mybot/bots/BotWallpapers") {}

const fail = (message: string) => new BotWallpaperError({ message });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const savePhoto: BotWallpapers["Service"]["savePhoto"] = Effect.fn("BotWallpapers.savePhoto")(
    function* (input) {
      const file = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: input.attachmentId,
      });
      if (file === null) return yield* fail("That upload could not be found. Try again.");
      const info = yield* fileSystem
        .stat(file)
        .pipe(Effect.mapError(() => fail("That upload could not be found. Try again.")));
      if (info.type !== "File" || Number(info.size) > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
        return yield* fail("Wallpaper photos must be an image of 10 MB or less.");
      const bytes = yield* fileSystem
        .readFile(file)
        .pipe(Effect.mapError(() => fail("Could not read the photo.")));
      const mimeType = sniffImageType(bytes);
      if (mimeType === null)
        return yield* fail("Wallpapers must be PNG, WebP, JPEG, or GIF images.");
      const hash = yield* crypto.digest("SHA-256", bytes).pipe(
        Effect.map(Hex.encode),
        Effect.mapError(() => fail("Could not save the photo.")),
      );
      const photoId = BotWallpaperPhotoId.make(`${hash}.${mimeType.slice("image/".length)}`);
      const target = path.join(config.wallpapersDir, photoId);
      if (!(yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false)))) {
        // Written beside the target and renamed, so a half-written photo is never served.
        const partial = `${target}.partial`;
        yield* fileSystem.makeDirectory(config.wallpapersDir, { recursive: true }).pipe(
          Effect.andThen(fileSystem.writeFile(partial, bytes)),
          Effect.andThen(fileSystem.rename(partial, target)),
          Effect.mapError(() => fail("Could not save the photo.")),
        );
      }
      return { photoId };
    },
  );

  return BotWallpapers.of({ savePhoto });
});

export const layer = Layer.effect(BotWallpapers, make);
