/** A bot's profile as every provider turn in its threads receives it. */
export interface BotInstructions {
  readonly name: string;
  readonly role: string;
  readonly instructions: string;
  /** The bot's own folder, which holds its memory file. */
  readonly folder: string;
  /** The skills folder every bot shares. */
  readonly skillsFolder: string;
  /** The user's other bots, which this bot can hand work to. */
  readonly teammates?: ReadonlyArray<{
    readonly name: string;
    readonly role: string;
    readonly projectId: string;
  }>;
  /** Set for a group chat: the bots (projectIds) this bot hosts the conversation with. */
  readonly members?: ReadonlyArray<string> | undefined;
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
  lines.push(
    "Before anything that leaves this computer or cannot be undone, such as sending a message or email, posting, paying, or deleting data, show the user exactly what you will do as a draft and wait for their go-ahead, unless their instructions below say otherwise.",
  );
  lines.push(
    "Websites you sign into in the shared browser stay signed in for every bot. When a site needs the user, such as a login, a two-factor code, a CAPTCHA, or a payment, leave the page open in your browser tab, say exactly what they need to do there (take control of the tab, finish the step, release control, then reply), and end your turn; continue when they reply. Never ask for passwords or one-time codes in chat. For an API key or token, use the request_secret tool.",
  );
  lines.push(
    "The user may have connected apps, such as their mail, calendar, or CRM. When a task involves one of their accounts, call app_tools_list to see the connected apps and their tools, and use app_tool_call when one fits; it is faster and more reliable than the website.",
  );
  lines.push(
    "When the user wants something done regularly or whenever something happens, set it up as a routine with the schedule_task tool if you have it, and tell the user the schedule you set.",
  );
  const memberIds = new Set(bot.members ?? []);
  const members = (bot.teammates ?? []).filter((teammate) => memberIds.has(teammate.projectId));
  const roster = (teammates: NonNullable<BotInstructions["teammates"]>) =>
    teammates.map(
      (teammate) =>
        `- ${toSingleLine(teammate.name)}${teammate.role ? ` (${toSingleLine(teammate.role)})` : ""}: projectId ${teammate.projectId}`,
    );
  if (bot.members !== undefined) {
    lines.push(
      "This is a group chat between the user and these bots, and you host it:",
      ...(members.length > 0
        ? roster(members)
        : ["- (no bots yet: ask the user to add some in this group's settings)"]),
      "For each user message, choose who answers: the bots the user names, otherwise the ones whose job fits, or every bot when the user addresses the group. Send each chosen bot the message with the context it needs from this chat. The first time you message a bot here, call t3_thread_launch with its projectId and keep the threadId it returns; after that, use t3_thread_send to that threadId so the bot remembers the chat. Message the chosen bots in parallel, then use t3_thread_wait and t3_thread_read to collect their replies, and pass one bot's reply to another when it asks for their input.",
      "Reply with each bot's answer under its name, in its own words: **Name:** answer. Do not answer for a bot. Add a short line of your own only to connect or summarize answers. When a bot needs the user, such as a question or an approval, relay it with the bot's name.",
    );
  } else if (bot.teammates && bot.teammates.length > 0) {
    lines.push(
      "The user's other bots, which you can hand work to when it fits their job better than yours:",
      ...roster(bot.teammates),
      "To hand off, call t3_thread_launch with that projectId and the full task in message; it runs as that bot, with its own instructions, memory, and model. Follow it with t3_thread_wait and t3_thread_read, then report back. Tell the user when you hand work off.",
    );
  }
  lines.push(
    "When the user wants to show you how to do something in a website, open its starting page in your browser tab, call preview_teach_start with the goal, and ask them to take control of the tab, do the task once, release control, and reply; then end your turn. When they reply, call preview_teach_stop and save the steps as a skill, with the specific values turned into inputs and the steps only the user can do marked as such.",
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
