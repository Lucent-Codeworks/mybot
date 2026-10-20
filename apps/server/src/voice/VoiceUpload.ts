import {
  VOICE_UPLOAD_MAX_BYTES,
  VOICE_UPLOAD_URL_TTL_MS,
  type VoiceCreateUploadUrlInput,
  VoiceInputError,
} from "@mybot/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";

export const VOICE_UPLOAD_ROUTE_PREFIX = "/api/voice/upload";

// Shared with asset and attachment tokens; the signed claim kind keeps them apart.
const SIGNING_SECRET_NAME = "asset-access-signing-key";
const WAV_HEADER_BYTES = 44;
/** Recordings nobody transcribed (closed tab, failed request) are deleted after this. */
const STALE_UPLOAD_MS = 15 * 60_000;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `<baseDir>/voice`, which holds whisper-cli, the model, and uploads. */
export const resolveVoiceDir = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.baseDir, "voice");
});

/** Upload ids are UUIDs, so a client-supplied id can never leave the uploads directory. */
export const isVoiceUploadId = (uploadId: string) => UPLOAD_ID.test(uploadId);

export const voiceUploadPath = (path: Path.Path, voiceDir: string, uploadId: string) =>
  path.join(voiceDir, "uploads", `${uploadId}.wav`);

const VoiceUploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("voice-upload"),
  uploadId: Schema.String,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
const claimsJson = Schema.fromJsonString(VoiceUploadClaims);
const decodeClaims = Schema.decodeUnknownOption(claimsJson);
const encodeClaims = Schema.encodeSync(claimsJson);

function parseClaims(encodedPayload: string): typeof VoiceUploadClaims.Type | null {
  try {
    return Option.getOrNull(decodeClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

const loadSigningSecret = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  return yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

/** RIFF/WAVE with a canonical 44-byte header: PCM, mono, 16,000 Hz, 16-bit. */
export const isPcm16Mono16kWav = (header: Uint8Array): boolean => {
  if (header.byteLength < WAV_HEADER_BYTES) return false;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const ascii = (offset: number, text: string) =>
    [...text].every((char, index) => header[offset + index] === char.charCodeAt(0));
  return (
    ascii(0, "RIFF") &&
    ascii(8, "WAVE") &&
    ascii(12, "fmt ") &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === 16_000 &&
    view.getUint16(34, true) === 16 &&
    ascii(36, "data")
  );
};

/** Deletes recordings older than STALE_UPLOAD_MS. */
const sweepStaleUploads = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const uploadsDir = path.join(yield* resolveVoiceDir, "uploads");
  const now = yield* Clock.currentTimeMillis;
  const names = yield* fs.readDirectory(uploadsDir).pipe(Effect.orElseSucceed(() => []));
  for (const name of names) {
    const file = path.join(uploadsDir, name);
    const info = yield* fs.stat(file).pipe(Effect.option);
    if (Option.isNone(info)) continue;
    const modified = Option.getOrUndefined(info.value.mtime)?.getTime() ?? 0;
    if (now - modified >= STALE_UPLOAD_MS) {
      yield* fs.remove(file, { force: true }).pipe(Effect.ignore);
    }
  }
});

export const issueVoiceUploadUrl = Effect.fn("VoiceUpload.issueUrl")(function* (
  input: VoiceCreateUploadUrlInput,
) {
  if (input.sizeBytes < WAV_HEADER_BYTES || input.sizeBytes > VOICE_UPLOAD_MAX_BYTES) {
    return yield* new VoiceInputError({
      reason: "transcription-failed",
      detail: "Recordings can be up to 5 minutes long.",
    });
  }
  const secret = yield* loadSigningSecret.pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to load the voice upload signing key.", { cause }),
    ),
    Effect.mapError(
      () =>
        new VoiceInputError({
          reason: "transcription-failed",
          detail: "This MyBot server could not accept the recording. Try again.",
        }),
    ),
  );
  yield* sweepStaleUploads;
  const crypto = yield* Crypto.Crypto;
  const uploadId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  const expiresAt = (yield* Clock.currentTimeMillis) + VOICE_UPLOAD_URL_TTL_MS;
  const encodedPayload = base64UrlEncode(
    encodeClaims({
      version: 1,
      kind: "voice-upload",
      uploadId,
      sizeBytes: input.sizeBytes,
      expiresAt,
    }),
  );
  return {
    uploadId,
    relativeUrl: `${VOICE_UPLOAD_ROUTE_PREFIX}/${encodedPayload}.${signPayload(encodedPayload, secret)}`,
    expiresAt,
  };
});

export const validateVoiceUploadToken = Effect.fn("VoiceUpload.validateToken")(function* (
  token: string,
) {
  const [encodedPayload, signature, unexpectedSegment] = token.split(".");
  if (!encodedPayload || !signature || unexpectedSegment) return null;
  const secret = yield* loadSigningSecret.pipe(Effect.orElseSucceed(() => null));
  if (!secret || !timingSafeEqualBase64Url(signature, signPayload(encodedPayload, secret))) {
    return null;
  }
  const claims = parseClaims(encodedPayload);
  if (
    !claims ||
    !isVoiceUploadId(claims.uploadId) ||
    claims.expiresAt <= (yield* Clock.currentTimeMillis)
  ) {
    return null;
  }
  return { uploadId: claims.uploadId, sizeBytes: claims.sizeBytes, expiresAt: claims.expiresAt };
});

const badRequest = (detail: string) => HttpServerResponse.text(detail, { status: 400 });

/**
 * `POST /api/voice/upload/<token>` with the WAV as the raw body. The signed
 * token is the authorization, like attachment uploads. Answers 204 once stored.
 */
export const layerVoiceUploadRoute = HttpRouter.add(
  "POST",
  `${VOICE_UPLOAD_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return badRequest("Bad Request");
    const token = url.value.pathname.slice(`${VOICE_UPLOAD_ROUTE_PREFIX}/`.length);
    const claims = yield* validateVoiceUploadToken(token);
    if (!claims) return HttpServerResponse.text("Not Found", { status: 404 });

    const contentLength = request.headers["content-length"];
    if (contentLength !== undefined && Number(contentLength) !== claims.sizeBytes) {
      return badRequest("Content-Length must match the upload size.");
    }

    // At most 9.6 MB, so the body is held in memory and checked before it touches disk.
    const body = new Uint8Array(claims.sizeBytes);
    let received = 0;
    let overflow = false;
    yield* request.stream.pipe(
      Stream.takeWhile(() => !overflow),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          if (received + chunk.byteLength > claims.sizeBytes) {
            overflow = true;
            return;
          }
          body.set(chunk, received);
          received += chunk.byteLength;
        }),
      ),
    );
    if (overflow || received !== claims.sizeBytes) {
      return badRequest(`Body must be ${claims.sizeBytes} bytes.`);
    }
    if (!isPcm16Mono16kWav(body.subarray(0, WAV_HEADER_BYTES))) {
      return badRequest("Voice audio must be 16 kHz mono WAV.");
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = voiceUploadPath(path, yield* resolveVoiceDir, claims.uploadId);
    return yield* Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      // `wx`: a token replayed within its lifetime cannot replace a stored recording.
      yield* fs.writeFile(file, body, { flag: "wx" });
      return HttpServerResponse.empty({ status: 204 });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to store a voice upload.", { cause }).pipe(
          Effect.as(HttpServerResponse.text("Failed to store the recording.", { status: 500 })),
        ),
      ),
    );
  }),
);
