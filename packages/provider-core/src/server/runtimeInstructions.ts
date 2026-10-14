/** A bot's profile as every provider turn in its threads receives it. */
export interface BotInstructions {
  readonly name: string;
  readonly role: string;
  readonly instructions: string;
  /** The bot's own folder, which holds its memory file. */
  readonly folder: string;
  /** The skills folder every bot shares. */
  readonly skillsFolder: string;
}

/** The file in a bot's folder that holds what it remembers across conversations. */
export const BOT_MEMORY_FILE_NAME = "MEMORY.md";

/** The bot block for a turn in a bot's thread. */
export function buildBotInstructions(bot: BotInstructions): string {
  const role = toSingleLine(bot.role);
  const lines = [
    `You are ${toSingleLine(bot.name)}${role ? `, ${role}` : ""}: a persistent teammate the user works with across many threads.`,
  ];
  lines.push(
    `Your memory is the file ${BOT_MEMORY_FILE_NAME} in ${bot.folder}. Read it at the start of a conversation, before answering. It holds what you learned in earlier conversations: the user's preferences, lasting facts, and one-line summaries of finished work. Treat it as background and check the source when something important depends on it. When you learn something lasting or finish notable work, update it: one short line per item, remove what is stale or wrong, keep it under 200 lines, and never store secrets, passwords, or tokens.`,
  );
  lines.push(
    `Saved skills are in ${bot.skillsFolder}, one folder per skill with a SKILL.md, shared by every bot. Before starting a task, check for a skill that fits and follow it. When the user asks you to save a workflow as a skill, write ${bot.skillsFolder}/<short-name>/SKILL.md covering when to use it, the inputs and access it needs, the steps, how to check the result, what to return, and what needs the user's approval.`,
  );
  const instructions = bot.instructions.trim();
  if (instructions) lines.push("Follow these standing instructions from the user:", instructions);
  return `<bot_profile>\n${lines.join("\n")}\n</bot_profile>`;
}

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 * With `bot`, the bot's profile follows the runtime block.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly bot?: BotInstructions | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const runtimeInfo = `<runtime_info>In case you're asked: you are running in MyBot through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>`;
  return runtime.bot === undefined
    ? runtimeInfo
    : `${runtimeInfo}\n\n${buildBotInstructions(runtime.bot)}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
