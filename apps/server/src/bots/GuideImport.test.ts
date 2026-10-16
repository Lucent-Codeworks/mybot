import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as GuideImport from "./GuideImport.ts";

const botId = ProjectId.make("expenses");

/** A solid square of one RGB color, as raw image stream bytes. */
const square = (side: number, rgb: readonly [number, number, number]) =>
  Buffer.from(Array.from({ length: side * side }, () => rgb).flat());

/** A PDF shaped like a Scribe export: a step's text and screenshot per page. */
function guidePdf(): Uint8Array {
  const image = (side: number, data: Buffer) =>
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${data.length} >>\nstream\n`,
      ),
      data,
      Buffer.from("\nendstream"),
    ]);
  const content = (text: string) => {
    const body = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET q 64 0 0 64 50 600 cm /Shot Do Q q 64 0 0 64 150 600 cm /Logo Do Q q 8 0 0 8 50 500 cm /Icon Do Q`;
    return Buffer.from(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  };
  const page = (contents: number, shot: number) =>
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Shot ${shot} 0 R /Logo 6 0 R /Icon 7 0 R >> >> >>`,
    );
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>"),
    page(10, 8),
    page(11, 9),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    image(64, square(64, [20, 20, 200])),
    image(8, square(8, [0, 0, 0])),
    image(64, square(64, [200, 20, 20])),
    image(64, square(64, [20, 200, 20])),
    content("1 Click New expense"),
    content("2 Choose a category"),
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets: Array<number> = [];
  let length = parts[0]!.length;
  objects.forEach((body, index) => {
    const part = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      body,
      Buffer.from("\nendobj\n"),
    ]);
    offsets.push(length);
    parts.push(part);
    length += part.length;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
  ].join("");
  return Buffer.concat([...parts, Buffer.from(xref)]);
}

const withGuideImport = <A, E>(
  run: (input: {
    readonly guides: GuideImport.GuideImport["Service"];
    readonly config: ServerConfig.ServerConfig["Service"];
    readonly botFolder: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const botFolder = yield* fileSystem.makeTempDirectoryScoped({ prefix: "guide-bot-" });
    const shell: OrchestrationProjectShell = {
      id: botId,
      title: "Expenses",
      workspaceRoot: botFolder,
      defaultModelSelection: null,
      bot: { role: "Files expenses", instructions: "" },
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const layer = GuideImport.layer.pipe(
      Layer.provide(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          getShell: (projectId) =>
            Effect.succeed(projectId === botId ? Option.some(shell) : Option.none()),
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "guide-import-" })),
    );
    return yield* Effect.gen(function* () {
      const guides = yield* GuideImport.GuideImport;
      const config = yield* ServerConfig.ServerConfig;
      return yield* run({ guides, config, botFolder });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

it.effect("saves a guide's step text and screenshots in the skill's folder", () =>
  withGuideImport(({ guides, config, botFolder }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const guide = path.join(botFolder, "expense.pdf");
      yield* fileSystem.writeFile(guide, guidePdf());
      const stale = path.join(config.skillsDir, "file-expense", "guide", "page-9-1.png");
      yield* fileSystem.makeDirectory(path.dirname(stale), { recursive: true });
      yield* fileSystem.writeFile(stale, new Uint8Array([1]));

      const result = yield* guides.importGuide({
        projectId: botId,
        path: guide,
        skill: "file-expense",
      });

      const folder = path.join(config.skillsDir, "file-expense");
      assert.equal(result.skillFolder, folder);
      assert.isFalse(result.truncated);
      // The logo repeats on every page and the icon is too small to be a screenshot.
      assert.deepEqual(result.pages, [
        {
          page: 1,
          text: "1 Click New expense",
          images: [
            path.join(folder, "guide", "page-1-1.png"),
            path.join(folder, "guide", "page-1-2.png"),
          ],
        },
        {
          page: 2,
          text: "2 Choose a category",
          images: [path.join(folder, "guide", "page-2-1.png")],
        },
      ]);
      assert.isFalse(yield* fileSystem.exists(stale));
      const png = yield* fileSystem.readFile(result.pages[1]!.images[0]!);
      assert.equal(Buffer.from(png.subarray(1, 4)).toString("ascii"), "PNG");
      assert.equal(Buffer.from(png).readUInt32BE(16), 64);
    }),
  ),
);

it.effect("refuses a file outside the attachments and the bot's folder", () =>
  withGuideImport(({ guides }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const elsewhere = yield* fileSystem.makeTempDirectoryScoped({ prefix: "guide-elsewhere-" });
      const guide = path.join(elsewhere, "expense.pdf");
      yield* fileSystem.writeFile(guide, guidePdf());

      const error = yield* guides
        .importGuide({ projectId: botId, path: guide, skill: "file-expense" })
        .pipe(Effect.flip);

      assert.include(error.message, "Only a file the user attached or one in your own folder");
    }),
  ),
);

it.effect("refuses a file that is not a PDF", () =>
  withGuideImport(({ guides, config }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const notes = path.join(config.attachmentsDir, "notes.pdf");
      yield* fileSystem.writeFileString(notes, "# How to file an expense");

      const error = yield* guides
        .importGuide({ projectId: botId, path: notes, skill: "file-expense" })
        .pipe(Effect.flip);

      assert.include(error.message, "not a PDF");
    }),
  ),
);

it.effect("refuses a skill folder that links outside the skills folder", () =>
  withGuideImport(({ guides, config, botFolder }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const guide = path.join(botFolder, "expense.pdf");
      yield* fileSystem.writeFile(guide, guidePdf());
      const outside = path.join(botFolder, "keep", GuideImport.GUIDE_IMAGES_FOLDER);
      yield* fileSystem.makeDirectory(outside, { recursive: true });
      yield* fileSystem.makeDirectory(config.skillsDir, { recursive: true });
      yield* fileSystem.symlink(path.dirname(outside), path.join(config.skillsDir, "file-expense"));

      const error = yield* guides
        .importGuide({ projectId: botId, path: guide, skill: "file-expense" })
        .pipe(Effect.flip);

      assert.include(error.message, "not a link");
      assert.isTrue(yield* fileSystem.exists(outside));
    }),
  ),
);
