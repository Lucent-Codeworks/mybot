import {
  assetUrlStateFromResult,
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
} from "@mybot/client-runtime/state/assets";
import { EnvironmentId, PetId } from "@mybot/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { projectFaviconCache } from "../assets/projectFaviconCache";
import { isElectron } from "../env";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentSession } from "./session";

const localMediaEnvironment = Atom.make((get) => {
  if (!isElectron) return null;
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return null;
  const connection = get(environmentSession.preparedConnectionValueAtom(environmentId));
  // The session's bootstrap config clears on disconnect and refreshes on reconnect.
  const config = get(environmentSession.initialConfigValueAtom(environmentId));
  return connection._tag === "None" || config === null
    ? null
    : { environmentId, httpBaseUrl: connection.value.httpBaseUrl };
});

export const assetEnvironment = createAssetEnvironmentAtoms(
  connectionAtomRuntime,
  localMediaEnvironment,
);

export const projectFaviconUrlAtom = createProjectFaviconUrlAtomFamily({
  imageCache: projectFaviconCache,
  createUrl: assetEnvironment.createUrl,
  preparedConnection: environmentSession.preparedConnectionValueAtom,
});

const PET_SPRITE_URL_IDLE_TTL_MS = 60 * 60_000;
const decodePetSpriteKey = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, PetId, Schema.String]),
);
const petSpriteUrlFamily = Atom.family((key: string) => {
  const [environmentId, petId, version] = decodePetSpriteKey(JSON.parse(key));
  const query = assetEnvironment.createUrl({
    environmentId,
    input: { resource: { _tag: "pet-sprite", petId, version } },
  });
  return Atom.make((get): string | null => {
    const connection = get(environmentSession.preparedConnectionValueAtom(environmentId));
    const state = assetUrlStateFromResult(
      get(query),
      Option.isSome(connection) ? connection.value.httpBaseUrl : null,
    );
    // Keep the last signed URL while the environment reconnects so the pet does not blink out.
    return state._tag === "Success" ? state.url : Option.getOrNull(get.self<string | null>());
  }).pipe(Atom.setIdleTTL(PET_SPRITE_URL_IDLE_TTL_MS));
});

/**
 * The signed URL of a pet's sprite sheet or picture, or null until one resolves.
 * Pass the pet's `updatedAt` as `version` so an edited pet fetches a fresh URL.
 */
export function petSpriteUrlAtom(target: {
  readonly environmentId: EnvironmentId;
  readonly petId: PetId;
  readonly version: string;
}) {
  return petSpriteUrlFamily(JSON.stringify([target.environmentId, target.petId, target.version]));
}
