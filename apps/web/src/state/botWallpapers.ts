import { assetUrlStateFromResult } from "@mybot/client-runtime/state/assets";
import { createEnvironmentRpcCommand } from "@mybot/client-runtime/state/runtime";
import { BotWallpaperPhotoId, EnvironmentId, WS_METHODS } from "@mybot/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { assetEnvironment } from "./assets";
import { environmentSession } from "./session";

export const saveWallpaperPhoto = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:bots:wallpaper-save-photo",
  tag: WS_METHODS.botsWallpaperSavePhoto,
});

const PHOTO_URL_IDLE_TTL_MS = 60 * 60_000;
const decodePhotoKey = Schema.decodeUnknownSync(Schema.Tuple([EnvironmentId, BotWallpaperPhotoId]));

const photoUrlFamily = Atom.family((key: string) => {
  const [environmentId, photoId] = decodePhotoKey(JSON.parse(key));
  const query = assetEnvironment.createUrl({
    environmentId,
    input: { resource: { _tag: "bot-wallpaper", photoId } },
  });
  return Atom.make((get): string | null => {
    const connection = get(environmentSession.preparedConnectionValueAtom(environmentId));
    const state = assetUrlStateFromResult(
      get(query),
      Option.isSome(connection) ? connection.value.httpBaseUrl : null,
    );
    // Keep the last signed URL while the environment reconnects so the wallpaper does not blink.
    return state._tag === "Success" ? state.url : Option.getOrNull(get.self<string | null>());
  }).pipe(Atom.setIdleTTL(PHOTO_URL_IDLE_TTL_MS));
});

/** The signed URL of a wallpaper photo, or null until one resolves. */
export function wallpaperPhotoUrlAtom(environmentId: EnvironmentId, photoId: BotWallpaperPhotoId) {
  return photoUrlFamily(JSON.stringify([environmentId, photoId]));
}
