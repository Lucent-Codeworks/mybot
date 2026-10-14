/** Telegram caps one message at 4096 characters. */
const TELEGRAM_MESSAGE_LIMIT = 4000;

/** What to do with one incoming private message, before any thread work. */
export type TelegramMessageAction =
  | { readonly type: "pair" }
  | { readonly type: "reject" }
  | { readonly type: "ignore" }
  | { readonly type: "greet" }
  | { readonly type: "new-conversation" }
  | { readonly type: "deliver"; readonly text: string };

/**
 * Only the paired account talks to a bot. Until one is paired, the first
 * account to send `/start <pairing code>` claims it; anyone else is refused.
 */
export function classifyTelegramMessage(input: {
  readonly ownerUserId: number | null;
  readonly pairingCode: string;
  readonly fromUserId: number;
  readonly text: string;
}): TelegramMessageAction {
  const text = input.text.trim();
  if (input.ownerUserId === null) {
    return text === `/start ${input.pairingCode}` ? { type: "pair" } : { type: "reject" };
  }
  if (input.fromUserId !== input.ownerUserId) return { type: "reject" };
  if (text.length === 0) return { type: "ignore" };
  if (text === "/start") return { type: "greet" };
  if (text === "/new") return { type: "new-conversation" };
  return { type: "deliver", text };
}

/** Splits a reply into Telegram-sized messages, preferring paragraph and line breaks. */
export function splitTelegramText(text: string): ReadonlyArray<string> {
  const chunks: Array<string> = [];
  let rest = text.trim();
  while (rest.length > TELEGRAM_MESSAGE_LIMIT) {
    const window = rest.slice(0, TELEGRAM_MESSAGE_LIMIT);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const end = cut > TELEGRAM_MESSAGE_LIMIT / 2 ? cut : TELEGRAM_MESSAGE_LIMIT;
    chunks.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
