# Bots

A bot is a teammate with a job. It has a name, a model, and standing
instructions that it follows in every conversation, so you can hand it the
same kind of work again and again without repeating yourself. Every
conversation in MyBot is with a bot. Projects from earlier versions that are
not bots are removed when MyBot starts, along with their conversations; their
folders and files stay on disk.

## Create a bot

Choose **New bot** under **Bots** in the sidebar, or run **New bot** from the
command palette. Pick a ready-made bot from the marketplace, or start from
scratch. The marketplace has bots for work, money, health, home, learning, and
hobbies; search it by what you want done, such as "meal planner" or "invoices",
or browse a category. A ready-made bot comes with its job, instructions, icon,
and starter skills; you can change any of them before or after creating it.
Then choose the model it should use. Any provider you have set up works.

MyBot creates a folder for the bot in its data directory and opens a new
conversation with it.

## Work with a bot

Select a bot in the sidebar to see only its conversations. Select it again to
see every thread. Hover a bot and choose the pen icon to start a new
conversation with it.

Before anything that leaves your computer or cannot be undone, such as sending
an email, posting, paying, or deleting data, a bot shows you a draft and waits
for your go-ahead. Write lasting rules into the instructions, including when a
bot may act without asking. Put one-off requests in the conversation.

## Auto Review

Turn on **Auto Review** in a bot's settings and the bot asks before acting, but
a reviewer model answers most of those requests for you. It approves actions
that are clearly safe, such as reading files or making small local changes
that fit the bot's instructions. Anything that sends data off your computer,
spends money, deletes or overwrites data, or touches credentials still comes
to you, in MyBot or on Telegram. The reviewer never refuses on your behalf.

The reviewer uses the model set for text generation, or the bot's own model.
Write limits into the bot's instructions, like "never touch the production
database", and the reviewer applies them too.

## Bots working together

Each bot knows your other bots and their jobs, and can message them. When a
request fits another bot's job better, it asks that bot and reports back with
the answer. The other bot works with its own instructions, memory, and model,
in one standing conversation with the bot that asked, so it remembers earlier
requests; you can open that conversation in its bot's list. If it needs your
approval or an answer, the first bot tells you where to go. You can also ask
for it directly, for example "ask Inbox to sort today's mail".

## MyBot

MyBot is your built-in assistant, created when MyBot first starts. Ask it
anything: it does the work itself or brings in the bot whose job fits, and
coordinates several bots when a task spans them. When none of your bots fits
work you will want again, it offers to create one. MyBot can't be deleted, but
you can change its model and instructions like any other bot's.

## Group chats

A group chat lets you talk to several bots in one conversation. Choose **New
bot**, then **Group chat**, and pick its bots. Each message goes to the bots you
name, or to the ones whose job fits, and every answer appears under the bot's
name. Each bot keeps its own conversation for the group, so it remembers what
was said. Change the group's bots in its settings.

## Sign a bot into websites

Bots browse in a shared browser that keeps its logins, so a site you sign into
for one bot works for all of them, even while the MyBot window is closed.

When a site needs you, such as a login, a two-factor code, or a CAPTCHA, the bot
leaves the page open and tells you what to do. Open its browser tab, choose
**Take control**, finish the step, choose **Release control**, and reply to the
bot. Never send passwords or codes in a chat; a bot that needs an API key asks
for it with a private form.

Bots browse with Google Chrome when it is installed on the machine running
MyBot, and with a built-in browser otherwise. Sites trust Chrome more, so if
CAPTCHAs keep failing, install Chrome there.

## Connect apps

Connect your apps so bots can use them directly instead of clicking through
websites. Choose **Apps** in the sidebar (or **Settings → Apps**) and choose **Add
app**. Search the catalog or browse by category, pick an app, and fill in what it
asks for. If an app isn't listed, choose **Custom** to connect any app that
offers an MCP server by its web address or a local command. MyBot checks the
connection before saving it, and keys and tokens stay on your computer.

Each app shows how it connects:

- **Sign in** apps open their sign-in page in your browser. Approve access
  there, then come back to MyBot. When a sign-in expires and cannot be renewed,
  the app shows **Sign in** in Connected apps and bots tell you it needs signing
  in again.
- **API key** apps ask for a key or token you create in the app's settings. Each
  field says where to find it and links to that page; apps that need more setup,
  such as creating a Slack app or a Discord bot, list the steps in the form.
- **Runs on this computer** apps start a small helper program on the computer
  running MyBot. MyBot downloads what they run on the first time you connect
  one, so the first connect can take a minute; only apps whose form says so need
  Docker installed. Apps marked **macOS** only work there.
- **No sign-in** apps work right away.

Apps marked **Community** use a helper made by the community rather than the
app's maker. Some apps list a requirement before you connect, such as a paid
plan or an admin who must turn on access.

Apps marked **Via Composio**, such as Gmail, Google Calendar, Drive, Docs, and
Sheets, connect through Composio: sign in to Composio once, and it asks you to
approve each app the first time a bot uses it. If you'd rather not use Composio,
**Google Workspace (advanced)** connects with your own Google Cloud OAuth client.

**Outlook & Microsoft 365** runs on this computer. After connecting it, ask a
bot to sign in to Microsoft; it shows a code to enter at
microsoft.com/devicelogin. Choose **Work or school** to also reach Teams and
SharePoint.

Every bot can use every connected app. Bots still show you a draft and wait for
your go-ahead before an app sends, posts, buys, or deletes anything.

## Memory

Each bot keeps a `MEMORY.md` file in its folder. It reads the file at the start
of a conversation and adds what it learns: your preferences, lasting facts, and
short notes on finished work. It is told never to store passwords or tokens.

You can read and edit the memory in the bot's settings. Remove anything that is
wrong or out of date; the bot uses what is there from its next conversation.

## Teach a bot a task

Show a bot how to do something in a website once, and it saves the steps as a
skill. Ask it, for example, "let me show you how to file an expense". The bot
opens the starting page in its browser tab and asks you to take over. Choose
**Take control**, do the task once, choose **Release control**, and reply.

Only what you do while in control is recorded. Passwords and one-time codes are
recorded as steps you do yourself, without their values. Files you upload are
recorded by name, as steps you supply the file for. Afterwards the bot
writes a skill it can repeat, with the details you entered turned into inputs.

You can also hand a bot a step-by-step guide you already have, such as a PDF
exported from Scribe. Attach it and ask, for example, "learn this as a skill".
The bot reads each step, keeps the guide's screenshots with the skill, and
follows them the next time.

## Skills

Ask a bot to save something it just did as a skill, and it writes the steps to
MyBot's shared `skills` folder. Every bot checks that folder before starting a
task and follows a skill that fits. A skill is a folder with a `SKILL.md`, so
you can also write or edit one by hand.

## Routines

Ask a bot to do something on a schedule, such as "every weekday at 9, check my
bookmarks", and it sets up a routine. Each run posts into the conversation that
created it. Manage routines in **Settings → Scheduled Tasks**.

Routines run on the computer that hosts MyBot. On Windows and Linux, closing the
MyBot window keeps it running in the system tray so routines keep working;
choose **Quit MyBot** from the tray icon to stop it.

## Message a bot from Telegram

Each bot can have its own Telegram bot, so you can reach it from your phone.

1. In Telegram, message @BotFather, send `/newbot`, and copy the token it gives you.
2. In MyBot, open the bot's settings, paste the token under **Telegram**, and choose **Connect**.
3. Send `/start` followed by the pairing code MyBot shows to your new Telegram bot.

After pairing, only your Telegram account can talk to the bot. Each Telegram chat
continues one conversation, which you can also open in MyBot; send `/new` to
start a fresh one. MyBot must be running for the bot to answer, and replies
arrive when the bot finishes. Choose **Disconnect** to stop.

You can send photos too, with or without a caption, such as a receipt for an
expenses bot. Other files are not supported yet.

When one of the bot's routines finishes, its result arrives in the chat too, so
a morning briefing reaches your phone.

When the bot needs your approval or asks you a question, it sends it to the
chat. Reply `yes`, `always`, or `no` to an approval, or a number (or your own
words) to a question. Questions with several parts still have to be answered
in MyBot.

## Change or remove a bot

Hover a bot and choose the gear icon, or choose **Bot settings** from a
conversation's menu. You can change its name, icon, job, and instructions
there, and its model under **New threads**. Instruction changes apply from the
next message, including in conversations that are already open.

**Delete bot** deletes the bot and its conversations. The files in its folder
stay on disk.
