# Bots

A bot is a project with a `bot` profile (`BotProfile` in `packages/contracts/src/project.ts`). Its
name, icon, and model are the project's title, icon, and `defaultModelSelection` project setting
override; its conversations are the project's threads. There is no separate bot aggregate, so every
project feature (threads, scripts, settings overrides, scheduled tasks) works for bots unchanged.

## Behavior lives in the bot block

Everything a bot does differently reaches the agent as text: `buildBotInstructions`
(`packages/provider-core/src/server/runtimeInstructions.ts`) renders a `<bot_profile>` block that
`RunExecutionService` attaches to every turn in a bot's thread, and each adapter adds next to its
runtime instructions. Memory, skills, routines, handoffs, and the draft-before-acting rule are
instructions plus plain files the agent already knows how to use, so they work for every provider
without per-adapter tools. Add new bot behavior here before reaching for a new MCP tool.

Two constraints follow from Claude fixing its system prompt when a query starts:

- The block is part of the Claude query key, so any change to it starts a new query that resumes the
  session. Keep the block stable between turns: no timestamps or per-turn data.
- Memory (`MEMORY.md` in the bot's folder) is read by the agent, never pasted into the block. Pasting
  it would restart Claude's query and break prompt caching every time the bot learned something.

## Handoffs

The block lists the user's other bots, and a bot hands work over with `t3_thread_launch` into the
other bot's project. A launch into another bot's project starts on that bot's model and never with a
broader runtime mode than that bot's own, so handed-off work runs as the receiving bot.

## Connected apps

`apps/server/src/apps/AppConnections.ts` is an MCP client for the apps a user connects, and the
T3 MCP server relays them through two fixed tools, `app_tools_list` and `app_tool_call`. Relaying,
instead of adding each app to each provider's MCP config, works the same for every adapter and keeps
the tool list (part of Claude's query key) stable when apps are added or removed. Configs, including
tokens and environment values, live in the server secret store and never reach clients.

A group chat is a bot whose profile has `members`. Its block replaces the handoff roster with a
host role: it relays each message to member bots with `t3_thread_launch`/`t3_thread_send` and quotes
their replies. Members stay ordinary bots in their own threads, so no orchestration change was
needed; group chats are left out of other bots' rosters.

## Telegram

`apps/server/src/channels/TelegramChannel.ts` long-polls the Bot API from the host, so it needs no
public URL or relay. The token lives in the server secret store and is part of every Bot API URL:
client tracing is turned off for those requests, and errors never carry the cause. Telegram replies
are read from the run's last assistant message; approvals and single questions are relayed through
`ThreadManagementService.waitForPendingRequest` and answered with `runtime-request.respond`.

## Auto Review

`AutoReviewService` asks a reviewer model, through the text-generation `reviewAction` operation,
about each approval request in a bot that turned it on. It can only approve: `ask` and any failure
leave the request for the user. Agents cannot enable it, and an agent's change to a reviewed bot's
instructions turns it off, because the reviewer treats those instructions as the user's rules.
