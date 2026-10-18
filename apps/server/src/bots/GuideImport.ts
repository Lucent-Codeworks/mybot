/**
 * Turns a step-by-step guide the user hands a bot, such as a PDF exported from
 * Scribe, into material for a skill: each page's text, plus the guide's
 * screenshots saved in the skill's folder. Done here rather than by the agent
 * because not every provider can read a PDF or the images inside it.
 */
import * as NodeZlib from "node:zlib";

import type { ProjectId } from "@mybot/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Base64 from "effect/encoding/Base64";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

/** The largest guide read; matches the largest file a message can attach. */
const MAX_GUIDE_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 200;
const MAX_PAGE_TEXT_CHARS = 4_000;
const MAX_IMAGES = 120;
/** Smaller images are icons and bullets, not screenshots. */
const MIN_IMAGE_SIDE = 48;
/** The folder inside a skill that holds the guide's screenshots. */
export const GUIDE_IMAGES_FOLDER = "guide";
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class GuideImportError extends Schema.TaggedError<GuideImportError>()("GuideImportError", {
  message: Schema.String,
}) {}

export interface GuidePage {
  readonly page: number;
  readonly text: string;
  /** Absolute paths of the screenshots first shown on this page. */
  readonly images: ReadonlyArray<string>;
}

export interface GuideImportResult {
  readonly skillFolder: string;
  readonly pages: ReadonlyArray<GuidePage>;
  /** Whether pages or images past the limits were left out. */
  readonly truncated: boolean;
}

export class GuideImport extends Context.Service<
  GuideImport,
  {
    /**
     * Reads the PDF at `path` for the bot `projectId` and saves its screenshots in
     * `<skills>/<skill>/guide`, replacing any saved before. The PDF must be in
     * the chat's attachments or the bot's own folder: this runs as the server,
     * outside the provider's sandbox, so it must not open any file it is named.
     */
    readonly importGuide: (input: {
      readonly projectId: ProjectId;
      readonly path: string;
      readonly skill: string;
    }) => Effect.Effect<GuideImportResult, GuideImportError>;
  }
>()("mybot/bots/GuideImport") {}

/** Encodes raw 8-bit gray, RGB, or RGBA pixels as a PNG. */
export function encodePng(image: {
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 3 | 4;
  readonly data: Uint8Array | Uint8ClampedArray;
}): Uint8Array {
  const { width, height, channels, data } = image;
  const stride = width * channels;
  // Every row starts with filter type 0 (none).
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    raw.set(data.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(NodeZlib.crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectStore.ProjectStoreV2;

  const fail = (message: string) => new GuideImportError({ message });
  const isInside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  const realPath = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => undefined));

  const importGuide: GuideImport["Service"]["importGuide"] = Effect.fn("GuideImport.importGuide")(
    function* (input) {
      if (!SKILL_NAME_PATTERN.test(input.skill))
        return yield* fail(
          "Use a short skill name of lowercase letters, digits, and dashes, such as file-expense.",
        );
      const project = yield* projects.getShell(input.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      if (!project?.bot) return yield* fail("Guides can only be imported in a bot's conversation.");

      const file = path.isAbsolute(input.path) ? yield* realPath(input.path) : undefined;
      if (file === undefined) return yield* fail(`There is no file at ${input.path}.`);
      const roots = [
        yield* realPath(config.attachmentsDir),
        yield* realPath(project.workspaceRoot),
      ].filter((root) => root !== undefined);
      if (!roots.some((root) => isInside(root, file)))
        return yield* fail(
          "Only a file the user attached or one in your own folder can be imported. Copy the guide into your folder first.",
        );
      const info = yield* fileSystem
        .stat(file)
        .pipe(Effect.mapError(() => fail(`Could not read ${input.path}.`)));
      if (info.type !== "File" || Number(info.size) > MAX_GUIDE_BYTES)
        return yield* fail("The guide must be a PDF file of 50 MB or less.");
      const bytes = yield* fileSystem
        .readFile(file)
        .pipe(Effect.mapError(() => fail(`Could not read ${input.path}.`)));
      if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-")
        return yield* fail(
          "That file is not a PDF. Read a guide in another format, such as HTML or Markdown, yourself.",
        );

      // Loaded on first use: pdf.js is large, and most servers never read a guide.
      const { getDocumentProxy, extractText, extractImages } = yield* Effect.promise(
        () => import("unpdf"),
      );
      const document = yield* Effect.acquireRelease(
        Effect.tryPromise({
          // pdf.js refuses a Node Buffer, which is what the file system returns.
          try: () => getDocumentProxy(new Uint8Array(bytes)),
          catch: () =>
            fail("The PDF could not be opened; it may be damaged or password protected."),
        }),
        (opened) => Effect.promise(() => opened.loadingTask.destroy()),
      );
      const pageCount = Math.min(document.numPages, MAX_PAGES);
      const { text } = yield* Effect.tryPromise({
        try: () => extractText(document, { mergePages: false }),
        catch: () => fail("The PDF's text could not be read."),
      });

      const skillFolder = path.join(config.skillsDir, input.skill);
      const imagesFolder = path.join(skillFolder, GUIDE_IMAGES_FOLDER);
      // The folder below is deleted and rewritten, so a link must not lead it elsewhere.
      const skillsRoot = yield* realPath(config.skillsDir);
      for (const folder of [skillFolder, imagesFolder]) {
        const resolved = yield* realPath(folder);
        if (resolved !== undefined && (skillsRoot === undefined || !isInside(skillsRoot, resolved)))
          return yield* fail(`${folder} must be a folder inside ${config.skillsDir}, not a link.`);
      }
      const prepare = Effect.gen(function* () {
        yield* fileSystem.remove(imagesFolder, { recursive: true, force: true });
        yield* fileSystem.makeDirectory(imagesFolder, { recursive: true });
      });
      yield* prepare.pipe(Effect.mapError(() => fail(`Could not write to ${imagesFolder}.`)));

      // Guides repeat logos and headers on every page; each image is saved once.
      const seen = new Set<string>();
      let saved = 0;
      let truncated = document.numPages > MAX_PAGES;
      const pages: Array<GuidePage> = [];
      for (let page = 1; page <= pageCount; page++) {
        const found = yield* Effect.tryPromise(() => extractImages(document, page)).pipe(
          Effect.orElseSucceed(() => []),
        );
        const images: Array<string> = [];
        for (const image of found) {
          if (image.width < MIN_IMAGE_SIDE || image.height < MIN_IMAGE_SIDE) continue;
          const pixels = new Uint8Array(
            image.data.buffer,
            image.data.byteOffset,
            image.data.length,
          );
          const key = yield* crypto.digest("SHA-256", pixels).pipe(
            Effect.map(Base64.encode),
            Effect.orElseSucceed(() => `${page}:${images.length}`),
          );
          if (seen.has(key)) continue;
          seen.add(key);
          if (saved >= MAX_IMAGES) {
            truncated = true;
            continue;
          }
          const target = path.join(imagesFolder, `page-${page}-${images.length + 1}.png`);
          yield* fileSystem
            .writeFile(target, encodePng(image))
            .pipe(Effect.mapError(() => fail(`Could not write ${target}.`)));
          images.push(target);
          saved += 1;
        }
        const pageText = (text[page - 1] ?? "").trim();
        if (pageText.length > MAX_PAGE_TEXT_CHARS) truncated = true;
        pages.push({ page, text: pageText.slice(0, MAX_PAGE_TEXT_CHARS), images });
      }
      return { skillFolder, pages, truncated };
    },
    Effect.scoped,
  );

  return GuideImport.of({ importGuide });
});

export const layer = Layer.effect(GuideImport, make);
