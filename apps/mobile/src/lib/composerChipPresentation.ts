import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";
/**
 * Every accent shares a lightness so no kind reads heavier than another; only hue carries
 * identity. These are the sRGB form of the same OKLCH set web uses, so a chip looks the
 * same on every surface. See `composerInlineChip.ts`.
 */
const CONTEXT_CHIP_PRESENTATIONS = {
  image: { accent: "#d55665", symbol: "photo" },
  video: { accent: "#d06217", symbol: "play.rectangle" },
  file: { accent: "#0090cd", symbol: "doc" },
  mention: { accent: "#0096af", symbol: "doc" },
  terminal: { accent: "#009f6e", symbol: "terminal" },
  element: { accent: "#b87501", symbol: "cursorarrow.click" },
  "preview-annotation": { accent: "#b87501", symbol: "cursorarrow.click" },
  "review-comment": { accent: "#8a70dd", symbol: "text.bubble" },
  skill: { accent: "#b261be", symbol: "cube" },
} as const;

/**
 * The size an attachment chip reports beside its name, matching web. Rendered as its own
 * smaller run, so it carries no separator. Only attachment-backed records have bytes.
 */
export function composerChipSizeSuffix(record?: {
  readonly kind?: string;
  readonly sizeBytes?: number;
}): string {
  if (record?.kind !== "file" && record?.kind !== "image") return "";
  return typeof record.sizeBytes === "number" ? formatAttachmentSize(record.sizeBytes) : "";
}

export function contextChipPresentation(
  kind: string,
  record?: {
    readonly kind?: string;
    readonly name?: string;
    readonly mimeType?: string;
  },
) {
  const presentationKind =
    kind === "file" &&
    videoMimeType({
      name: record?.name ?? "",
      mimeType: record?.mimeType ?? "",
    })
      ? "video"
      : // A picture chosen through the file picker is typed `file`, but it is still a
        // picture: it reads as one to the user and should not wear the generic file chip.
        kind === "file" &&
          imageMimeType({ name: record?.name ?? "", mimeType: record?.mimeType ?? "" }) !== null
        ? "image"
        : kind;
  return Object.hasOwn(CONTEXT_CHIP_PRESENTATIONS, presentationKind)
    ? CONTEXT_CHIP_PRESENTATIONS[presentationKind as keyof typeof CONTEXT_CHIP_PRESENTATIONS]
    : CONTEXT_CHIP_PRESENTATIONS.file;
}
