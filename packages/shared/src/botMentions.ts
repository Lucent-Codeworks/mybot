import type { ComposerContextId, ProjectId } from "@mybot/contracts";

import {
  BOT_MENTION_KIND,
  collectComposerContextReferences,
  formatComposerContextReference,
} from "./composerContextReferences.ts";

const MENTIONABLE_ID = /^[a-z0-9_-]{1,128}$/i;

/**
 * The text the composer inserts for `@Name`. A bot whose id cannot ride in a
 * reference link (none MyBot creates) gets plain `@Name`, which routes nowhere.
 */
export function formatBotMention(bot: { readonly id: ProjectId; readonly title: string }): string {
  if (!MENTIONABLE_ID.test(bot.id)) return `@${bot.title}`;
  return formatComposerContextReference({
    kind: BOT_MENTION_KIND,
    contextId: bot.id as string as ComposerContextId,
    label: bot.title,
  });
}

/** The bots a message mentions, in order, each once. */
export function mentionedBotIds(text: string): ReadonlyArray<ProjectId> {
  const ids = collectComposerContextReferences(text).flatMap((reference) =>
    reference.kind === BOT_MENTION_KIND ? [reference.contextId as string as ProjectId] : [],
  );
  return [...new Set(ids)];
}

interface MentionableBot {
  readonly id: ProjectId;
  readonly bot?: { readonly members?: ReadonlyArray<string> | undefined } | null | undefined;
}

/**
 * The bot that answers `text` in a chat hosted by `hostId`: the first mentioned
 * bot other than the host, or undefined when the host answers. Group chats only
 * host, so they never answer.
 */
export function answeringBot<B extends MentionableBot>(
  text: string,
  bots: ReadonlyArray<B>,
  hostId: ProjectId,
): B | undefined {
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  for (const id of mentionedBotIds(text)) {
    const bot = byId.get(id);
    if (bot?.bot != null && bot.bot.members === undefined && bot.id !== hostId) return bot;
  }
  return undefined;
}
