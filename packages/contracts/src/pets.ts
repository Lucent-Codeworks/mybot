import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ChatAttachmentId } from "./chatAttachment.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** A pet's folder name and identity: a lowercase slug, safe to use as a path segment. */
export const PetId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)).pipe(
  Schema.brand("PetId"),
);
export type PetId = typeof PetId.Type;

export const PET_DISPLAY_NAME_MAX_LENGTH = 40;
export const PET_DESCRIPTION_MAX_LENGTH = 200;

const PetDisplayName = TrimmedNonEmptyString.check(Schema.isMaxLength(PET_DISPLAY_NAME_MAX_LENGTH));
const PetDescription = Schema.String.check(Schema.isMaxLength(PET_DESCRIPTION_MAX_LENGTH));

/** An atlas pet animates a spritesheet; a picture pet shows one still image. */
export const PetKind = Schema.Literals(["atlas", "picture"]);
export type PetKind = typeof PetKind.Type;

export const PetSource = Schema.Literals(["builtin", "import", "codex", "picture", "hatched"]);
export type PetSource = typeof PetSource.Type;

export const Pet = Schema.Struct({
  id: PetId,
  displayName: PetDisplayName,
  description: PetDescription,
  kind: PetKind,
  atlasVersion: Schema.optional(Schema.Literals([1, 2])),
  source: PetSource,
  builtIn: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type Pet = typeof Pet.Type;

export const PetHatchJobStatus = Schema.Literals(["hatching", "done", "failed", "cancelled"]);
export type PetHatchJobStatus = typeof PetHatchJobStatus.Type;

export const PetHatchJob = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  displayName: PetDisplayName,
  description: PetDescription,
  status: PetHatchJobStatus,
  error: Schema.optional(Schema.String),
  petId: Schema.optional(PetId),
  followUps: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type PetHatchJob = typeof PetHatchJob.Type;

export const PetRowName = Schema.Literals([
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
]);
export type PetRowName = typeof PetRowName.Type;

/** Spritesheet geometry shared by every atlas pet. v2 adds rows MyBot does not use. */
export const PET_ATLAS = {
  cellWidth: 192,
  cellHeight: 208,
  columns: 8,
  v1: { rows: 9, width: 1536, height: 1872 },
  v2: { rows: 11, width: 1536, height: 2288 },
} as const;

/** Atlas rows in order. The frame count of a row is the length of its durations. */
export const PET_ROWS: ReadonlyArray<{
  name: PetRowName;
  row: number;
  frameDurationsMs: ReadonlyArray<number>;
}> = [
  { name: "idle", row: 0, frameDurationsMs: [280, 110, 110, 140, 140, 320] },
  { name: "running-right", row: 1, frameDurationsMs: [120, 120, 120, 120, 120, 120, 120, 220] },
  { name: "running-left", row: 2, frameDurationsMs: [120, 120, 120, 120, 120, 120, 120, 220] },
  { name: "waving", row: 3, frameDurationsMs: [140, 140, 140, 280] },
  { name: "jumping", row: 4, frameDurationsMs: [140, 140, 140, 140, 280] },
  { name: "failed", row: 5, frameDurationsMs: [140, 140, 140, 140, 140, 140, 140, 240] },
  { name: "waiting", row: 6, frameDurationsMs: [150, 150, 150, 150, 150, 260] },
  { name: "running", row: 7, frameDurationsMs: [120, 120, 120, 120, 120, 220] },
  { name: "review", row: 8, frameDurationsMs: [150, 150, 150, 150, 150, 280] },
];

/** The atlas version a spritesheet of this pixel size has, or null when it matches neither. */
export function petAtlasVersionForSize(width: number, height: number): 1 | 2 | null {
  if (width === PET_ATLAS.v1.width && height === PET_ATLAS.v1.height) return 1;
  if (width === PET_ATLAS.v2.width && height === PET_ATLAS.v2.height) return 2;
  return null;
}

export const PetsListResult = Schema.Struct({
  pets: Schema.Array(Pet),
  hatchJobs: Schema.Array(PetHatchJob),
});
export type PetsListResult = typeof PetsListResult.Type;

/** A pet found in a connected Codex install that can be imported. */
export const CodexPetCandidate = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  folderName: TrimmedNonEmptyString,
  displayName: Schema.String,
  description: Schema.String,
});
export type CodexPetCandidate = typeof CodexPetCandidate.Type;

export const PetImportInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("upload"),
    attachmentId: ChatAttachmentId,
    displayName: PetDisplayName,
    description: PetDescription,
  }),
  Schema.Struct({
    type: Schema.Literal("codex"),
    providerInstanceId: ProviderInstanceId,
    folderName: TrimmedNonEmptyString,
  }),
]);
export type PetImportInput = typeof PetImportInput.Type;

export const PetCreatePictureInput = Schema.Struct({
  attachmentId: ChatAttachmentId,
  displayName: PetDisplayName,
});
export type PetCreatePictureInput = typeof PetCreatePictureInput.Type;

export const PetRenameInput = Schema.Struct({
  petId: PetId,
  displayName: PetDisplayName,
});
export type PetRenameInput = typeof PetRenameInput.Type;

export const PetRemoveInput = Schema.Struct({ petId: PetId });
export type PetRemoveInput = typeof PetRemoveInput.Type;

export const PetHatchInput = Schema.Struct({
  projectId: ProjectId,
  displayName: PetDisplayName,
  description: PetDescription,
  referenceAttachmentId: Schema.optional(ChatAttachmentId),
});
export type PetHatchInput = typeof PetHatchInput.Type;

export const PetErrorCode = Schema.Literals([
  "invalid_image",
  "invalid_manifest",
  "not_found",
  "read_only",
  "codex_unavailable",
  "io",
]);
export type PetErrorCode = typeof PetErrorCode.Type;

export class PetError extends Schema.TaggedError<PetError>()("PetError", {
  code: PetErrorCode,
  message: Schema.String,
}) {}
