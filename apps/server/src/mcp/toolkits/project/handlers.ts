import {
  type BotProfile,
  MessageId,
  ThreadId,
  OrchestratorMcpFailure,
  ProjectId,
} from "@mybot/contracts";
import { resolveProjectSettings } from "@mybot/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as BuiltInMyBot from "../../../bots/BuiltInMyBot.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { runtimeModeRank } from "../../../orchestration-v2/DispatchModeLimit.ts";
import { newCommandId, readCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

const botRequired = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: new Project.ProjectBotRequiredError({}).message,
  });

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});
/**
 * Auto Review is the user's to grant. An agent cannot turn it on, and an
 * agent's change to a reviewed bot's instructions turns it off, because the
 * reviewer reads those instructions as the user's rules.
 */
export function withoutAgentAutoReview(
  bot: BotProfile | null | undefined,
  existing: BotProfile | null | undefined,
): BotProfile | null | undefined {
  if (bot == null) return bot;
  const { autoReview: _requested, ...profile } = bot;
  // The pet is the user's pick, so an update that does not mention it keeps it.
  const kept =
    bot.petId === undefined && existing?.petId !== undefined
      ? { ...profile, petId: existing.petId }
      : profile;
  return existing?.autoReview === true && existing.instructions === bot.instructions
    ? { ...kept, autoReview: true }
    : kept;
}

export const layer = McpToolAccess.toLayer(ProjectToolkit, {
  t3_thread_launch: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode }) =>
      Effect.gen(function* () {
        const context = yield* readCaller();
        const { caller } = context;
        const commandId = yield* newCommandId();
        const threadId = ThreadId.make(commandId);
        const messageId = MessageId.make(commandId);
        const attachments = input.attachments ?? [];
        if (attachments.some((attachment) => !Claims.attachmentIsPendingUpload(attachment)))
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "A new thread accepts only pending attachment uploads.",
          });
        const projectId = yield* resolveProjectId(context, input.projectId);
        const readProject = Project.ProjectService.pipe(
          Effect.flatMap((projects) => projects.getById(projectId)),
          Effect.mapError(unavailable),
          Effect.map(Option.getOrUndefined),
        );
        // Handing work to another bot runs it as that bot: on the bot's own
        // model, and never with broader permissions than the bot's own.
        const otherProject = projectId !== caller?.projectId ? yield* readProject : undefined;
        const botSettings = otherProject?.bot
          ? resolveProjectSettings(
              yield* ServerSettings.ServerSettingsService.pipe(
                Effect.flatMap((settings) => settings.getSettings),
                Effect.mapError(unavailable),
              ),
              otherProject.id,
              otherProject,
            ).settings
          : null;
        const launchRuntimeMode =
          botSettings !== null &&
          runtimeModeRank[botSettings.defaultRuntimeMode] < runtimeModeRank[runtimeMode]
            ? botSettings.defaultRuntimeMode
            : runtimeMode;
        const modelSelection =
          input.modelSelection ??
          botSettings?.defaultModelSelection ??
          caller?.modelSelection ??
          (otherProject ?? (yield* readProject))?.defaultModelSelection ??
          undefined;
        if (modelSelection === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
          });
        const result = yield* ThreadMessageIntake.launchThread({
          commandId,
          threadId,
          projectId,
          title: input.title,
          modelSelection,
          runtimeMode: launchRuntimeMode,
          interactionMode,
          ...(input.message === undefined && attachments.length === 0
            ? {}
            : {
                initialMessage: {
                  messageId,
                  ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                  text: input.message ?? "",
                  attachments,
                },
              }),
          createdBy: "agent",
          creationSource: "mcp",
        }).pipe(
          Effect.mapError((error) => {
            if (error._tag === "AttachmentClaimError") {
              return new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.message,
              });
            }
            if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
              return new OrchestratorMcpFailure({
                code: "invalid_request",
                message: error.message,
              });
            }
            return unavailable();
          }),
        );
        const thread = result.projection.thread;
        const run = result.projection.runs.find((run) => run.userMessageId === messageId);
        return {
          threadId: thread.id,
          projectId: thread.projectId,
          modelSelection: thread.modelSelection,
          runId: run?.id ?? null,
          status: run?.status ?? null,
        };
      }),
  ),
  t3_project_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
      const rows = snapshot.projects.filter((project) => project.deletedAt === null);
      const start = input.cursor ?? 0,
        end = start + (input.limit ?? 20);
      return { projects: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
    }),
  ),
  t3_project_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const projects = yield* access;
      const result = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(result))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      return result.value;
    }),
  ),
  t3_project_create: McpToolAccess.writesEnvironment(({ workspaceRoot, ...input }) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      // Only startup creates the built-in MyBot.
      const bot = BuiltInMyBot.withoutOrchestrator(input.bot);
      if (bot == null) return yield* botRequired();
      if (workspaceRoot === undefined) {
        // Reject what this mode would otherwise drop silently.
        if (input.scripts !== undefined || input.createWorkspaceRootIfMissing !== undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "A project started from its title takes only a title, bot, and defaultModelSelection; set scripts afterwards with t3_project_update.",
          });
        const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
        const created = yield* folders
          .createNamedProject({
            name: input.title,
            bot: withoutAgentAutoReview(bot, null)!,
            ...(input.defaultModelSelection
              ? { defaultModelSelection: input.defaultModelSelection }
              : {}),
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
            ),
          );
        const project = yield* projects
          .getById(created.projectId)
          .pipe(
            Effect.mapError(unavailable),
            Effect.flatMap(
              Option.match({ onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed }),
            ),
          );
        return project;
      }
      const commandId = yield* newCommandId();
      return yield* projects
        .create({
          ...input,
          bot: withoutAgentAutoReview(bot, null),
          workspaceRoot,
          commandId,
          projectId: ProjectId.make(commandId),
        })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  t3_project_update: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      if (input.bot === null) return yield* botRequired();
      const projects = yield* Project.ProjectService;
      const existing =
        input.bot === undefined
          ? undefined
          : Option.getOrUndefined(
              yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable)),
            )?.bot;
      // The built-in MyBot keeps its flag; no other bot can take it.
      const bot =
        input.bot === undefined
          ? undefined
          : existing?.orchestrator === true
            ? { ...input.bot, orchestrator: true }
            : BuiltInMyBot.withoutOrchestrator(input.bot);
      return yield* projects
        .update({
          ...input,
          ...(bot === undefined ? {} : { bot: withoutAgentAutoReview(bot, existing) }),
          commandId: yield* newCommandId(),
        })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
  t3_project_delete: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      yield* BuiltInMyBot.assertDeletable(projects, input.projectId).pipe(
        Effect.mapError((error) =>
          error._tag === "ProjectBuiltInError"
            ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
            : unavailable(),
        ),
      );
      return yield* projects
        .delete({ ...input, commandId: yield* newCommandId() })
        .pipe(Effect.mapError(projectFailure));
    }),
  ),
});
