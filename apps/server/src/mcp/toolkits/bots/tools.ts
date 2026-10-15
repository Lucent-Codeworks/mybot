import { OrchestratorMcpFailure, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BotMessaging from "../../../bots/BotMessaging.ts";
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

export const BotsToolkit = Toolkit.make(BotMessageTool);
