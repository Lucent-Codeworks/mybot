# Bots

A bot is a project with a `bot` profile (`BotProfile` in `packages/contracts/src/project.ts`). Its
name, icon, and model are the project's title, icon, and `defaultModelSelection` project setting
override; its conversations are the project's threads. There is no separate bot aggregate, so every
project feature (threads, settings overrides, scheduled tasks) works for bots unchanged.

Every project is a bot. `ProjectService` stays profile-agnostic; its entry points (RPC, HTTP, CLI,
MCP) refuse a project without a bot profile with `ProjectBotRequiredError`, and
[`PlainProjectCleanup`](../../apps/server/src/project/PlainProjectCleanup.ts) deletes any plain
project left at startup, including legacy imports, while keeping its folder on disk.

## Behavior lives in the bot block

Everything a bot does differently reaches the agent as text: `buildBotInstructions`
(`packages/provider-core/src/server/runtimeInstructions.ts`) renders a `<bot_profile>` block that
`RunExecutionService` attaches to every turn in a bot's thread, and each adapter adds next to its
runtime instructions. Memory, skills, routines, and the draft-before-acting rule are
instructions plus plain files the agent already knows how to use, so they work for every provider
without per-adapter tools. Add new bot behavior here before reaching for a new MCP tool.

Two constraints follow from Claude fixing its system prompt when a query starts:

- The block is part of the Claude query key, so any change to it starts a new query that resumes the
  session. Keep the block stable between turns: no timestamps or per-turn data.
- Memory (`MEMORY.md` in the bot's folder) is read by the agent, never pasted into the block. Pasting
  it would restart Claude's query and break prompt caching every time the bot learned something.

## Bot messages

The block lists the user's other bots by name, and a bot asks another with the `bot_message` MCP
tool ([`BotMessaging`](../../apps/server/src/bots/BotMessaging.ts)). Each sender and receiver pair
has one standing conversation in the receiving bot's project, under a thread id derived from the two
project ids, so the receiver remembers earlier messages; an archived or deleted one is skipped for
the next numbered id, because a deleted thread's id must never be created again. The conversation
starts on the receiving bot's model and never with broader modes than its own or the sender's, so
the work runs as the receiving bot. The sender waits for the final reply; a receiver that stops on
the user returns `waiting_on_user` instead of timing out silently. In-flight waits are tracked per
bot in memory, and a message that would close a loop (or exceed four bots in one chain) is refused,
since the receiver's conversation would queue behind the very wait it answers.

## Built-in MyBot

[`BuiltInMyBot`](../../apps/server/src/bots/BuiltInMyBot.ts) creates one bot with
`bot.orchestrator` at startup when none exists. Its block tells it to route requests to the bot
whose job fits. Entry points (RPC, HTTP, CLI, MCP) refuse deleting it, keep its flag through
updates, and refuse or strip the flag anywhere else, so there is only ever one.

## Connected apps

`apps/server/src/apps/AppConnections.ts` is an MCP client for the apps a user connects, and the
T3 MCP server relays them through two fixed tools, `app_tools_list` and `app_tool_call`. Relaying,
instead of adding each app to each provider's MCP config, works the same for every adapter and keeps
the tool list (part of Claude's query key) stable when apps are added or removed. Configs, including
tokens and environment values, live in the server secret store and never reach clients; summaries
show only a URL's host or a command without its arguments, since both can carry keys.

`mcpClient.ts` and `mcpOAuth.ts` are hand-written instead of using `@modelcontextprotocol/sdk`: the
server ships as a single executable that cannot load the SDK's file-backed dependencies (the SDK is
a test-only devDependency). HTTP apps that answer 401 sign in with the MCP authorization flow
(protected resource and authorization server metadata, dynamic client registration, PKCE, and a
`resource` indicator). The browser returns to `GET /oauth/apps/callback` on the origin the client
reported (`redirectBaseUrl`), so local, LAN, and Tailscale origins all work without a fixed public
URL. That route has no session check: the single-use, ten-minute `state` is the credential, and
pending sign-ins live in memory, so a restart only means signing in again. The route is untraced
because its query carries the code. A refused refresh drops the tokens and marks the app
needs-sign-in rather than removing it. `packages/shared/src/appCatalog.ts` is the data-only list of
presets the Add app dialog offers.

A group chat is a bot whose profile has `members`. Its block replaces the roster with a host role:
it relays each message to member bots with `bot_message` and quotes their replies. Members stay
ordinary bots in their own threads; group chats are left out of other bots' rosters and cannot
receive `bot_message`.

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
