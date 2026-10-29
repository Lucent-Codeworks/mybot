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

## Mentions

`@Name` in the composer inserts a `bot` reference link (`[Name](t3-context://v1/bot/<projectId>)`)
with no context record: the link carries the bot's id, so renaming a bot never misroutes a sent
message, and providers read it as plain `@Name`. A mention runs that one turn as the mentioned bot
inside the current chat instead of relaying through `bot_message`, so its reply, tool calls, and
approvals stay where the user is and it sees the whole chat. Two places agree on who answers by
reading the same message: [`BotMentions`](../../apps/server/src/bots/BotMentions.ts), at client
message intake, puts the turn on the bot's model and queues it behind a running turn rather than
steering another bot's turn; `RunExecutionService` gives the turn that bot's profile. A turn's model
sticks to the thread, so the next message without a mention goes back to the model the chat's own
bot last ran on, unless the user picked a different one. Switching providers per turn uses the
ordinary provider-switch handoff.

## Built-in MyBot

[`BuiltInMyBot`](../../apps/server/src/bots/BuiltInMyBot.ts) creates one bot with
`bot.orchestrator` at startup when none exists. Its block tells it to route requests to the bot
whose job fits. Entry points (RPC, HTTP, CLI, MCP) refuse deleting it, keep its flag through
updates, and refuse or strip the flag anywhere else, so there is only ever one.

## Connected apps

`apps/server/src/apps/AppConnections.ts` is an MCP client for the apps a user connects, and the
MyBot MCP server relays them through two fixed tools, `app_tools_list` and `app_tool_call`. Relaying,
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

Local apps saved as `npx` or `uvx` never run the machine's own Node.js or uv.
[`LocalRuntimes.ts`](../../apps/server/src/apps/LocalRuntimes.ts) rewrites them at start time to a
pinned Node.js and uv it downloads, checks against SHA-256s in the code, and unpacks into
`<baseDir>/runtimes` (npm, uv, and uv's own Python cache there too). Most users have neither
installed, an old system Node breaks current packages, and on Windows `npx` is a `.cmd` shim that
cannot be spawned without a shell. Saved connections keep the plain command, so a new pin applies
to them on the next start. Docker apps still use the machine's Docker.

A group chat is a bot whose profile has `members`. Its block replaces the roster with a host role:
it relays each message to member bots with `bot_message` and quotes their replies. Members stay
ordinary bots in their own threads; group chats are left out of other bots' rosters and cannot
receive `bot_message`.

## Guides

`skill_import_guide` ([`GuideImport`](../../apps/server/src/bots/GuideImport.ts)) reads a guide PDF
on the server and saves its screenshots as PNGs in the skill's `guide/` folder, because not every
provider can read a PDF or the images in it. It runs as the server, outside the provider's sandbox,
so it only opens files under the attachments directory or the calling bot's folder. pdf.js loads on
first use to keep it off server startup.

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
