import type { EnvironmentId, OrchestrationProjectShell, ProjectId } from "@mybot/contracts";

const COMPOSER_BOT_RESULT_LIMIT = 6;

export interface ComposerBotCandidate extends Pick<
  OrchestrationProjectShell,
  "id" | "title" | "bot"
> {
  readonly environmentId: EnvironmentId;
}

export interface ComposerBotItem<B extends ComposerBotCandidate = ComposerBotCandidate> {
  readonly id: string;
  readonly type: "bot";
  readonly bot: B;
  readonly label: string;
  readonly description: string;
}

/**
 * Bots the `@` picker offers ahead of file paths: picking one makes that bot
 * answer the message in this chat. Only bots on the composer's server can
 * answer, and the chat's own bot and group chats are left out. A bare `@`
 * lists them all, in the order given; a query keeps the names that contain it,
 * prefix matches first.
 */
export function matchComposerBotItems<B extends ComposerBotCandidate>(input: {
  bots: ReadonlyArray<B>;
  environmentId: EnvironmentId;
  excludeProjectId: ProjectId | null;
  query: string;
}): ComposerBotItem<B>[] {
  const query = input.query.trim().toLowerCase();
  return input.bots
    .filter(
      (bot) =>
        bot.environmentId === input.environmentId &&
        bot.id !== input.excludeProjectId &&
        bot.bot != null &&
        bot.bot.members === undefined &&
        bot.title.toLowerCase().includes(query),
    )
    .map((bot, order) => ({ bot, order, prefix: bot.title.toLowerCase().startsWith(query) }))
    .sort((left, right) => Number(right.prefix) - Number(left.prefix) || left.order - right.order)
    .slice(0, COMPOSER_BOT_RESULT_LIMIT)
    .map(({ bot }) => ({
      id: `bot:${bot.environmentId}:${bot.id}`,
      type: "bot",
      bot,
      label: bot.title,
      description: bot.bot?.role?.trim() || "Bot",
    }));
}
