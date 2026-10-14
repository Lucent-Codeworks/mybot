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

/** An approval the bot is waiting on, worded for a chat. */
export function formatApprovalPrompt(input: {
  readonly title: string | null;
  readonly prompt: string | undefined;
}): string {
  const what = [input.title, input.prompt].filter(Boolean).join("\n\n");
  return `The bot needs your approval${what ? `:\n\n${what}` : "."}\n\nReply yes, always (for this conversation), or no.`;
}

/** The approval decision a chat reply means, or null when it means none. */
export function parseApprovalReply(text: string): "accept" | "acceptForSession" | "decline" | null {
  const reply = text.trim().toLowerCase();
  if (["yes", "y", "ok", "okay", "approve", "allow", "go", "go ahead"].includes(reply)) {
    return "accept";
  }
  if (["always", "always allow", "yes always"].includes(reply)) return "acceptForSession";
  if (["no", "n", "deny", "decline", "stop", "cancel"].includes(reply)) return "decline";
  return null;
}

export interface TelegramQuestion {
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly value?: string | undefined }>;
  readonly multiSelect?: boolean | undefined;
  readonly allowCustomAnswer?: boolean | undefined;
}

/** A question the bot is waiting on, with numbered options. */
export function formatQuestion(question: TelegramQuestion): string {
  const options = question.options.map((option, index) => `${index + 1}. ${option.label}`);
  const how =
    question.options.length === 0
      ? "Reply with your answer."
      : question.multiSelect
        ? "Reply with the numbers you pick, like 1, 3."
        : question.allowCustomAnswer === false
          ? "Reply with a number."
          : "Reply with a number, or with your own answer.";
  return [question.question, ...options, "", how].join("\n");
}

/** The answer a chat reply gives, or null when it does not answer the question. */
export function parseQuestionReply(
  question: TelegramQuestion,
  text: string,
): string | ReadonlyArray<string> | null {
  const reply = text.trim();
  if (reply.length === 0) return null;
  const optionValue = (index: number) => {
    const option = question.options[index - 1];
    return option === undefined ? undefined : (option.value ?? option.label);
  };
  if (/^\d+(\s*,\s*\d+)*$/.test(reply) && question.options.length > 0) {
    const values = reply.split(",").map((part) => optionValue(Number(part.trim())));
    if (values.some((value) => value === undefined)) return null;
    const picked = values as ReadonlyArray<string>;
    if (question.multiSelect) return [...new Set(picked)];
    return picked.length === 1 ? picked[0]! : null;
  }
  return question.allowCustomAnswer === false && question.options.length > 0 ? null : reply;
}
