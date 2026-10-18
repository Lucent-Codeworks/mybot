/**
 * ManagedProjectFolders - the project folders MyBot makes for the user under
 * its data dir, rather than ones the user picks:
 *
 * - `<baseDir>/projects/<slug>`: bots started from just a name, each with a
 *   README, a memory file, and an icon.
 *
 * `<baseDir>/scratch` once held the plain "No project" project. MyBot only has
 * bots now, so nothing creates it; PlainProjectCleanup removes the old record
 * and leaves the folder.
 *
 * @module ManagedProjectFolders
 */
import { CommandId, ProjectId, type ProjectCreateNewInput } from "@mybot/contracts";
import { newProjectFolderName } from "@mybot/shared/path";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { BOT_MEMORY_FILE_NAME } from "@mybot/provider-core/server/runtimeInstructions";
import { findBotTemplate } from "@mybot/shared/botTemplates";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";

export class NamedProjectFolderError extends Schema.TaggedError<NamedProjectFolderError>()(
  "NamedProjectFolderError",
  {
    folder: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the project folder.";
  }
}

export class NamedProjectCreateError extends Schema.TaggedError<NamedProjectCreateError>()(
  "NamedProjectCreateError",
  {
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to create the project.";
  }
}

export type NamedProjectError =
  | NamedProjectFolderError
  | NamedProjectCreateError
  | ProjectService.ProjectBotRequiredError;

export class ManagedProjectFolders extends Context.Service<
  ManagedProjectFolders,
  {
    /** The old Scratch folder, still reported so clients can recognize its leftovers. */
    readonly scratchRoot: string;
    /** The folder that holds projects started from just a name. */
    readonly namedProjectsRoot: string;
    /**
     * Starts a project from just a name: claims `<namedProjectsRoot>/<slug>`
     * (adding `-2`, `-3`, ... when taken), writes a README and an icon, then
     * creates the project. The folder is removed when the create fails or is
     * cancelled before the project exists, never once another project owns it.
     * `bot` is required: every project is a bot. `defaultModelSelection` becomes the
     * project's model override, the model its new threads start with.
     */
    readonly createNamedProject: (input: ProjectCreateNewInput) => Effect.Effect<
      {
        readonly projectId: ProjectId;
        readonly workspaceRoot: string;
      },
      NamedProjectError
    >;
  }
>()("mybot/project/ManagedProjectFolders") {}

// Tailwind 600 shades: dark enough for white initials on every hue.
const ICON_BACKGROUNDS = [
  "#dc2626",
  "#ea580c",
  "#d97706",
  "#16a34a",
  "#059669",
  "#0d9488",
  "#0891b2",
  "#0284c7",
  "#2563eb",
  "#4f46e5",
  "#7c3aed",
  "#9333ea",
  "#c026d3",
  "#db2777",
  "#e11d48",
] as const;

const MAX_NAMED_FOLDER_ATTEMPTS = 100;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * A rounded square with the name's initials, colored by a hash of the name.
 * It lives at `assets/icon.svg`, a path ProjectFaviconResolver already checks,
 * so every machine that clones the project shows the same icon.
 */
function namedProjectIconSvg(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const initials =
    words
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("")
      .toUpperCase() ||
    Array.from(name.trim())[0] ||
    "?";
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  const background = ICON_BACKGROUNDS[hash % ICON_BACKGROUNDS.length];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`,
    `  <rect width="64" height="64" rx="14" fill="${background}"/>`,
    `  <text x="32" y="32" dy="0.35em" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="${initials.length > 1 ? 26 : 32}" font-weight="600" fill="#ffffff">${escapeXml(initials)}</text>`,
    `</svg>`,
    "",
  ].join("\n");
}

function namedProjectReadme(name: string): string {
  return [
    `<img src="assets/icon.svg" width="64" height="64" alt="">`,
    "",
    `# ${name}`,
    "",
    "Created in [MyBot](https://github.com/Lucent-Codeworks/mybot).",
    "",
  ].join("\n");
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;

  /**
   * Claims the first free folder among `folderFor(1)`, `folderFor(2)`, ...,
   * stopping with None when `folderFor` runs out of names. Each folder is
   * created without `recursive`, so creating it is the claim: of two racers
   * for one name, one gets AlreadyExists and moves on to the next, so no two
   * projects ever share a folder.
   */
  const claimFreeFolder = Effect.fnUntraced(function* <E>(
    folderFor: (attempt: number) => Effect.Effect<Option.Option<string>, E>,
    onError: (folder: string, cause: PlatformError.PlatformError) => E,
  ) {
    for (let attempt = 1; ; attempt++) {
      const folder = yield* folderFor(attempt);
      if (Option.isNone(folder)) return folder;
      const claimed = yield* fileSystem.makeDirectory(folder.value).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
        Effect.mapError((cause) => onError(folder.value, cause)),
      );
      if (claimed) return folder;
    }
  });

  const scratchRoot = path.resolve(config.baseDir, "scratch");

  // Projects started from just a name live beside Scratch, away from folders
  // the user organizes by hand.
  const namedProjectsRoot = path.resolve(config.baseDir, "projects");

  const claimNamedFolder = Effect.fn("ManagedProjectFolders.claimNamedFolder")(function* (
    name: string,
  ) {
    yield* fileSystem
      .makeDirectory(namedProjectsRoot, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new NamedProjectFolderError({ folder: namedProjectsRoot, cause }),
        ),
      );
    const folderName = newProjectFolderName(name);
    const claimed = yield* claimFreeFolder(
      (attempt) =>
        Effect.succeed(
          attempt > MAX_NAMED_FOLDER_ATTEMPTS
            ? Option.none()
            : Option.some(
                path.join(
                  namedProjectsRoot,
                  attempt === 1 ? folderName : `${folderName}-${attempt}`,
                ),
              ),
        ),
      (folder, cause) => new NamedProjectFolderError({ folder, cause }),
    );
    if (Option.isSome(claimed)) return claimed.value;
    return yield* new NamedProjectFolderError({
      folder: path.join(namedProjectsRoot, folderName),
      cause: `Every folder name for "${folderName}" is taken.`,
    });
  });

  const scaffoldFolder = Effect.fn("ManagedProjectFolders.scaffoldFolder")(function* (
    cwd: string,
    name: string,
  ) {
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), namedProjectReadme(name));
    // The bot keeps this file itself; starting it here lets the user see it from day one.
    yield* fileSystem.writeFileString(path.join(cwd, BOT_MEMORY_FILE_NAME), "# Memory\n");
    yield* fileSystem.makeDirectory(path.join(cwd, "assets"));
    yield* fileSystem.writeFileString(
      path.join(cwd, "assets", "icon.svg"),
      namedProjectIconSvg(name),
    );
  });

  const createNamedProject: ManagedProjectFolders["Service"]["createNamedProject"] = Effect.fn(
    "ManagedProjectFolders.createNamedProject",
  )(function* (input) {
    // Checked before the folder is claimed, so a refused create leaves nothing on disk.
    const bot = input.bot;
    if (bot === undefined) return yield* new ProjectService.ProjectBotRequiredError({});
    const workspaceRoot = yield* claimNamedFolder(input.name);
    const removeFolder = fileSystem.remove(workspaceRoot, { recursive: true }).pipe(Effect.ignore);
    // Until the create is dispatched nothing else can use the folder, so any
    // exit but success removes it, an interrupt included.
    const [, id] = yield* Effect.all([
      scaffoldFolder(workspaceRoot, input.name).pipe(
        Effect.mapError((cause) => new NamedProjectFolderError({ folder: workspaceRoot, cause })),
      ),
      crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })),
      ),
    ]).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : removeFolder)));
    const project = yield* projects
      .create({
        commandId: CommandId.make(`named-project:${id}`),
        projectId: ProjectId.make(id),
        title: input.name,
        workspaceRoot,
        bot,
      })
      .pipe(
        // A rejected create leaves the folder unused, so remove it. An
        // interrupt can land after the create is committed, and a conflict
        // means another project owns the folder, so it stays then; the owner
        // is checked again first, since deleting another project's files is
        // never acceptable.
        Effect.tapError((error) =>
          error._tag === "ProjectConflictError"
            ? Effect.void
            : projects.getByWorkspaceRoot(workspaceRoot).pipe(
                Effect.flatMap((owner) => (Option.isNone(owner) ? removeFolder : Effect.void)),
                Effect.ignore,
              ),
        ),
        Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })),
      );
    if (input.projectIcon !== undefined) {
      yield* projects
        .update({
          commandId: CommandId.make(`named-project:${id}:icon`),
          projectId: project.id,
          projectIcon: input.projectIcon,
        })
        .pipe(Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })));
    }
    // A template's starter skills join the shared library; one the user
    // already has (or edited) is never overwritten. A failed write only
    // costs the skill, not the bot.
    const template = input.templateId === undefined ? undefined : findBotTemplate(input.templateId);
    for (const skill of template?.skills ?? []) {
      const skillFile = path.join(config.skillsDir, skill.name, "SKILL.md");
      yield* fileSystem.exists(skillFile).pipe(
        Effect.flatMap((exists) =>
          exists
            ? Effect.void
            : fileSystem
                .makeDirectory(path.dirname(skillFile), { recursive: true })
                .pipe(Effect.andThen(fileSystem.writeFileString(skillFile, skill.content))),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Could not install a template skill.", { skill: skill.name, cause }),
        ),
      );
    }
    if (input.defaultModelSelection !== undefined) {
      yield* serverSettings
        .updateSettings({
          projectSettingsOverrides: {
            [project.id]: { defaultModelSelection: input.defaultModelSelection },
          },
        })
        .pipe(Effect.mapError((cause) => new NamedProjectCreateError({ workspaceRoot, cause })));
    }
    return { projectId: project.id, workspaceRoot };
  });

  return ManagedProjectFolders.of({
    scratchRoot,
    namedProjectsRoot,
    createNamedProject,
  });
});

export const layer = Layer.effect(ManagedProjectFolders, make);
