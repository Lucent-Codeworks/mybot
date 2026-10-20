import type { AssetResource, EnvironmentId } from "@mybot/contracts";
import type { ImageSource } from "expo-image";

/**
 * expo-image source for a signed asset URL. Every mint signs a new URL, and a
 * reconnect mints again, so a URL-keyed cache misses each time. Attachments
 * never change once stored, so they cache under their id instead; a pet's
 * sprite caches under its id and version, which changes with the image.
 */
export function assetImageSource(
  environmentId: EnvironmentId,
  resource: AssetResource,
  uri: string,
): ImageSource {
  if (resource._tag === "attachment") {
    return {
      uri,
      cacheKey: `t3-attachment:${JSON.stringify([environmentId, resource.attachmentId])}`,
    };
  }
  if (resource._tag === "pet-sprite" && resource.version !== undefined) {
    return {
      uri,
      cacheKey: `t3-pet:${JSON.stringify([environmentId, resource.petId, resource.version])}`,
    };
  }
  return { uri };
}
