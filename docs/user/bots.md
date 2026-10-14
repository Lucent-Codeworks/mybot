# Bots

A bot is a teammate with a job. It has a name, a model, and standing
instructions that it follows in every conversation, so you can hand it the
same kind of work again and again without repeating yourself.

## Create a bot

Choose **New bot** under **Bots** in the sidebar, or run **New bot** from the
command palette. Give it a name, a job (for example "Daily tech scout"), its
instructions, and the model it should use. Any provider you have set up works.

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

## Bots working together

Each bot knows your other bots and their jobs. When a request fits another
bot's job better, it hands the task over: the work runs as a new conversation
with that bot, using its instructions, memory, and model, and the first bot
reports back with the result. You can also ask for it directly, for example
"ask Inbox to sort today's mail".

## Memory

Each bot keeps a `MEMORY.md` file in its folder. It reads the file at the start
of a conversation and adds what it learns: your preferences, lasting facts, and
short notes on finished work. It is told never to store passwords or tokens.

You can read and edit the memory in the bot's settings. Remove anything that is
wrong or out of date; the bot uses what is there from its next conversation.

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

## Change or remove a bot

Hover a bot and choose the gear icon, or open its project settings. You can
change its name, icon, job, and instructions there, and its model under **New
threads**. Instruction changes apply from the next message, including in
conversations that are already open.

**Make a plain project** removes the job and instructions but keeps the
conversations. Any project can become a bot with **Make a bot**.
