import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A bot's Telegram channel, as its settings show it. */
export const BotTelegramStatus = Schema.Struct({
  connected: Schema.Boolean,
  /** The Telegram bot's @username, once connected. */
  username: Schema.NullOr(Schema.String),
  /** Whether a Telegram account has claimed the bot with its pairing code. */
  paired: Schema.Boolean,
  /** The code to send as `/start <code>` until the bot is paired. */
  pairingCode: Schema.NullOr(Schema.String),
});
export type BotTelegramStatus = typeof BotTelegramStatus.Type;

export const BotTelegramStatusInput = Schema.Struct({ projectId: ProjectId });
export type BotTelegramStatusInput = typeof BotTelegramStatusInput.Type;

export const BotTelegramConnectInput = Schema.Struct({
  projectId: ProjectId,
  /** The token @BotFather gives for the Telegram bot. */
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type BotTelegramConnectInput = typeof BotTelegramConnectInput.Type;

export const BotTelegramDisconnectInput = Schema.Struct({ projectId: ProjectId });
export type BotTelegramDisconnectInput = typeof BotTelegramDisconnectInput.Type;

export class BotTelegramError extends Schema.TaggedError<BotTelegramError>()("BotTelegramError", {
  message: Schema.String,
}) {}
