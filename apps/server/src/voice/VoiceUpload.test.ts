// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { VOICE_UPLOAD_MAX_BYTES } from "@mybot/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  VOICE_UPLOAD_ROUTE_PREFIX,
  isPcm16Mono16kWav,
  issueVoiceUploadUrl,
  layerVoiceUploadRoute,
  validateVoiceUploadToken,
  voiceUploadPath,
} from "./VoiceUpload.ts";

/** A canonical 44-byte WAV header followed by `dataBytes` of silence. */
const wav = (
  dataBytes: number,
  format: { sampleRate?: number; channels?: number; bits?: number } = {},
) => {
  const sampleRate = format.sampleRate ?? 16_000;
  const channels = format.channels ?? 1;
  const bits = format.bits ?? 16;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++)
      bytes[offset + index] = text.charCodeAt(index);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, (sampleRate * channels * bits) / 8, true);
  view.setUint16(32, (channels * bits) / 8, true);
  view.setUint16(34, bits, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return bytes;
};

const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "mybot-voice-upload-" });
const layerTest = ServerSecretStore.layer.pipe(
  Layer.provideMerge(configLayer),
  Layer.provideMerge(NodeServices.layer),
);

describe("isPcm16Mono16kWav", () => {
  it("accepts 16 kHz mono PCM16 and rejects other audio", () => {
    expect(isPcm16Mono16kWav(wav(0))).toBe(true);
    expect(isPcm16Mono16kWav(wav(0, { sampleRate: 44_100 }))).toBe(false);
    expect(isPcm16Mono16kWav(wav(0, { channels: 2 }))).toBe(false);
    expect(isPcm16Mono16kWav(wav(0, { bits: 8 }))).toBe(false);
    const notRiff = wav(0);
    notRiff.set([0x52, 0x49, 0x46, 0x58]);
    expect(isPcm16Mono16kWav(notRiff)).toBe(false);
    expect(isPcm16Mono16kWav(wav(0).subarray(0, 20))).toBe(false);
  });
});

describe("voice upload URLs", () => {
  it.effect("signs a voice upload and rejects sizes outside a WAV recording", () =>
    Effect.gen(function* () {
      const issued = yield* issueVoiceUploadUrl({ sizeBytes: 64 });
      const token = issued.relativeUrl.slice(`${VOICE_UPLOAD_ROUTE_PREFIX}/`.length);
      expect(yield* validateVoiceUploadToken(token)).toEqual({
        uploadId: issued.uploadId,
        sizeBytes: 64,
        expiresAt: issued.expiresAt,
      });
      expect(yield* validateVoiceUploadToken(`${token}x`)).toBeNull();
      yield* TestClock.adjust("11 minutes");
      expect(yield* validateVoiceUploadToken(token)).toBeNull();

      const oversized = yield* issueVoiceUploadUrl({ sizeBytes: VOICE_UPLOAD_MAX_BYTES + 1 }).pipe(
        Effect.flip,
      );
      expect(oversized._tag).toBe("VoiceInputError");
      expect((yield* issueVoiceUploadUrl({ sizeBytes: 43 }).pipe(Effect.flip))._tag).toBe(
        "VoiceInputError",
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("removes uploads older than 15 minutes when issuing a URL", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const voiceDir = path.join(config.baseDir, "voice");
      const stale = voiceUploadPath(path, voiceDir, "00000000-0000-4000-8000-000000000001");
      NodeFS.mkdirSync(path.dirname(stale), { recursive: true });
      NodeFS.writeFileSync(stale, wav(0));
      const old = (yield* Clock.currentTimeMillis) - 16 * 60_000;
      NodeFS.utimesSync(stale, old / 1_000, old / 1_000);
      const fresh = voiceUploadPath(path, voiceDir, "00000000-0000-4000-8000-000000000002");
      NodeFS.writeFileSync(fresh, wav(0));

      yield* issueVoiceUploadUrl({ sizeBytes: 64 });
      expect(NodeFS.existsSync(stale)).toBe(false);
      expect(NodeFS.existsSync(fresh)).toBe(true);
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("voice upload route", () => {
  it.live("rejects oversized and non-WAV bodies and stores a valid recording", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const provided = Layer.mergeAll(
        Layer.succeed(ServerConfig.ServerConfig, config),
        Layer.succeed(
          ServerSecretStore.ServerSecretStore,
          yield* ServerSecretStore.ServerSecretStore,
        ),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(
        // Route handlers read their services from the layer's output.
        layerVoiceUploadRoute.pipe(
          Layer.provideMerge(provided),
          Layer.provide(
            HttpPlatform.layer.pipe(
              Layer.provideMerge(NodeServices.layer),
              Layer.provideMerge(Etag.layerWeak),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const path = yield* Path.Path;
      const voiceDir = path.join(config.baseDir, "voice");
      const post = (relativeUrl: string, body: Uint8Array<ArrayBuffer>) =>
        Effect.promise(() =>
          handler(
            new Request(`http://env.local${relativeUrl}`, {
              method: "POST",
              body,
              headers: { "content-type": "audio/wav", "content-length": String(body.byteLength) },
            }),
          ),
        );

      const small = yield* issueVoiceUploadUrl({ sizeBytes: 64 });
      expect((yield* post(small.relativeUrl, wav(64))).status).toBe(400);
      expect(NodeFS.existsSync(voiceUploadPath(path, voiceDir, small.uploadId))).toBe(false);

      const stereo = yield* issueVoiceUploadUrl({ sizeBytes: 64 });
      const notMono = yield* post(stereo.relativeUrl, wav(20, { channels: 2 }));
      expect(notMono.status).toBe(400);
      expect(yield* Effect.promise(() => notMono.text())).toBe(
        "Voice audio must be 16 kHz mono WAV.",
      );
      expect(NodeFS.existsSync(voiceUploadPath(path, voiceDir, stereo.uploadId))).toBe(false);

      const valid = yield* issueVoiceUploadUrl({ sizeBytes: 64 });
      expect((yield* post(valid.relativeUrl, wav(20))).status).toBe(204);
      expect(NodeFS.readFileSync(voiceUploadPath(path, voiceDir, valid.uploadId)).byteLength).toBe(
        64,
      );

      expect((yield* post(`${VOICE_UPLOAD_ROUTE_PREFIX}/garbage.sig`, wav(20))).status).toBe(404);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
