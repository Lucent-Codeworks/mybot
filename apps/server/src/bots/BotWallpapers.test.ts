import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { encodePng } from "../pets/png.ts";
import * as BotWallpapers from "./BotWallpapers.ts";

const layer = BotWallpapers.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-wallpapers-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("saves an uploaded photo once, named by its content", () =>
  Effect.gen(function* () {
    const wallpapers = yield* BotWallpapers.BotWallpapers;
    const config = yield* ServerConfig.ServerConfig;
    const png = encodePng({ width: 2, height: 2, channels: 4, data: new Uint8Array(16).fill(200) });
    for (const name of ["upload-a", "upload-b"]) {
      NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, `${name}.png`), png);
    }
    const first = yield* wallpapers.savePhoto({ attachmentId: "upload-a" });
    const second = yield* wallpapers.savePhoto({ attachmentId: "upload-b" });
    expect(first.photoId).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(second).toEqual(first);
    expect(NodeFS.readdirSync(config.wallpapersDir)).toEqual([first.photoId]);
    expect(NodeFS.readFileSync(NodePath.join(config.wallpapersDir, first.photoId))).toEqual(
      Buffer.from(png),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses an upload that is not an image", () =>
  Effect.gen(function* () {
    const wallpapers = yield* BotWallpapers.BotWallpapers;
    const config = yield* ServerConfig.ServerConfig;
    NodeFS.writeFileSync(NodePath.join(config.attachmentsDir, "notes.png"), "just text");
    const error = yield* wallpapers.savePhoto({ attachmentId: "notes" }).pipe(Effect.flip);
    expect(error.message).toContain("PNG, WebP, JPEG, or GIF");
  }).pipe(Effect.provide(layer)),
);
