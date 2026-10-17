import { OrchestratorMcpFailure, ProjectId, ThreadId } from "@mybot/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BotMessaging from "../../../bots/BotMessaging.ts";
import * as GuideImport from "../../../bots/GuideImport.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const BotMessageTool = Tool.make("bot_message", {
  description:
    "Message another of the user's bots: ask it something or hand it work. It runs as that bot, with its own instructions, memory, and model, in one standing conversation between you and it, so it remembers your earlier messages. By default this waits for its final reply and returns it. If it stops to ask the user for an approval or an answer, this returns status waiting_on_user with its conversation's threadId: tell the user. Only works from a bot's conversation; group chats cannot receive messages.",
  parameters: Schema.Struct({
    to: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
      description: "The other bot's name (any case) or its projectId.",
    }),
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)).annotate({
      description:
        "The full message, with all the context the other bot needs: it does not see your conversation.",
    }),
    wait: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Wait for the reply (default true). Set false to deliver it and return at once with the threadId.",
      }),
    ),
  }),
  success: Schema.Struct({
    to: Schema.String,
    projectId: ProjectId,
    threadId: ThreadId,
    status: Schema.Literals(["replied", "delivered", "waiting_on_user", "still_working", "failed"]),
    reply: Schema.NullOr(Schema.String),
    note: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    BotMessaging.BotMessaging,
  ],
})
  .annotate(Tool.Title, "Message a bot")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const SkillImportGuideTool = Tool.make("skill_import_guide", {
  description:
    "Read a step-by-step guide PDF the user gave you, such as one exported from Scribe, to save it as a skill. Returns each page's text and saves the guide's screenshots as PNG files in the skill's folder, under guide/. Look at the screenshots for where each step happens, then write SKILL.md in that folder. The PDF must be a file the user attached or one in your own folder. Only works from a bot's conversation.",
  parameters: Schema.Struct({
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
      description: "The absolute path of the PDF.",
    }),
    skill: Schema.String.check(Schema.isPattern(GuideImport.SKILL_NAME_PATTERN)).annotate({
      description:
        "The skill's folder name: lowercase letters, digits, and dashes, such as file-expense. Screenshots saved there before by this tool are replaced.",
    }),
  }),
  success: Schema.Struct({
    skillFolder: Schema.String,
    pages: Schema.Array(
      Schema.Struct({
        page: Schema.Number,
        text: Schema.String,
        images: Schema.Array(Schema.String),
      }),
    ),
    truncated: Schema.Boolean,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    GuideImport.GuideImport,
  ],
})
  .annotate(Tool.Title, "Import a guide")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const BotsToolkit = Toolkit.make(BotMessageTool, SkillImportGuideTool);
