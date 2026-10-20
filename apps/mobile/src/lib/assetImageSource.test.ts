import { EnvironmentId, PetId } from "@mybot/contracts";
import { describe, expect, it } from "vite-plus/test";

import { assetImageSource } from "./assetImageSource";

const environmentId = EnvironmentId.make("environment-1");

describe("assetImageSource", () => {
  it("caches an attachment under one key across re-signed URLs", () => {
    const resource = { _tag: "attachment", attachmentId: "thread-1-photo.jpg" } as const;
    const first = assetImageSource(
      environmentId,
      resource,
      "https://host/api/assets/token-a/p.jpg",
    );
    const second = assetImageSource(
      environmentId,
      resource,
      "https://host/api/assets/token-b/p.jpg",
    );

    expect(first.cacheKey).toBeDefined();
    expect(second).toStrictEqual({
      uri: "https://host/api/assets/token-b/p.jpg",
      cacheKey: first.cacheKey,
    });
    expect(
      assetImageSource(EnvironmentId.make("environment-2"), resource, "https://other/p.jpg")
        .cacheKey,
    ).not.toBe(first.cacheKey);
  });

  it("keeps ids that contain colons from sharing a key", () => {
    const uri = "https://host/api/assets/token/p.jpg";
    const left = assetImageSource(
      EnvironmentId.make("a"),
      { _tag: "attachment", attachmentId: "b:c" },
      uri,
    );
    const right = assetImageSource(
      EnvironmentId.make("a:b"),
      { _tag: "attachment", attachmentId: "c" },
      uri,
    );

    expect(left.cacheKey).not.toBe(right.cacheKey);
  });

  it("keeps workspace files keyed by URL because they can change on disk", () => {
    const source = assetImageSource(
      environmentId,
      { _tag: "draft-workspace-file", cwd: "/repo", path: "logo.png" },
      "https://host/api/assets/token-a/logo.png",
    );

    expect(source).toStrictEqual({ uri: "https://host/api/assets/token-a/logo.png" });
  });
  it("caches a pet sprite under its id and version, not its signed URL", () => {
    const petId = PetId.make("lucky");
    const first = assetImageSource(
      environmentId,
      { _tag: "pet-sprite", petId, version: "2026-10-19T00:00:00.000Z" },
      "https://host/api/assets/token-a/sprite.webp",
    );
    const resigned = assetImageSource(
      environmentId,
      { _tag: "pet-sprite", petId, version: "2026-10-19T00:00:00.000Z" },
      "https://host/api/assets/token-b/sprite.webp",
    );
    const replaced = assetImageSource(
      environmentId,
      { _tag: "pet-sprite", petId, version: "2026-10-20T00:00:00.000Z" },
      "https://host/api/assets/token-c/sprite.webp",
    );

    expect(first.cacheKey).toBeDefined();
    expect(resigned.cacheKey).toBe(first.cacheKey);
    expect(replaced.cacheKey).not.toBe(first.cacheKey);
    expect(
      assetImageSource(environmentId, { _tag: "pet-sprite", petId }, "https://host/s.webp"),
    ).toStrictEqual({ uri: "https://host/s.webp" });
  });
});
