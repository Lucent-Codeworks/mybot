# MyBot

MyBot gives you AI teammates that run on your own computer. Each bot has a name, a job, and
standing instructions, and works through the coding agents you already pay for: Claude Code,
Codex, Cursor, Grok Build, OpenCode, Pi, and Google Antigravity.

- **Bots with a job.** Create a bot, describe what it is for, and pick its model. Every
  conversation with it follows those instructions.
- **Memory and skills.** Bots keep notes on what they learn in a `MEMORY.md` you can read and
  edit, and save workflows as skills that every bot can reuse.
- **Routines.** Ask a bot to do something every morning or whenever a webhook fires. MyBot keeps
  running in the system tray so routines run with the window closed.
- **Telegram.** Give a bot its own Telegram bot and message it from your phone, approve its
  actions, and get routine results there.
- **Safety.** Bots show a draft before acting outside your computer. Turn on Auto Review and a
  reviewer model approves the clearly safe actions and leaves the rest to you.
- **Teamwork.** Bots know each other and hand work to the one whose job fits.

## Install

Download the desktop app for macOS, Windows, or Linux from
[GitHub Releases](https://github.com/Lucent-Codeworks/mybot/releases). On Debian or Ubuntu:

```bash
sudo apt install ./MyBot-*.deb
```

Install and sign in to at least one provider first:

- Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
- Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
- Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
- OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
- Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**.

Then choose **New bot** in the sidebar. The [bots guide](./docs/user/bots.md) covers memory,
skills, routines, Telegram, and Auto Review.

## Documentation

User guides live in [docs/user](./docs/user), starting with [bots](./docs/user/bots.md).
Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## Develop

MyBot uses [Vite+](https://viteplus.dev/guide/). Install the `vp` command, then:

```bash
vp i
vp run dev
```

See [docs/operations/development.md](./docs/operations/development.md) for the full runbook.

## Credits

MyBot is a fork of [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools, used under the
MIT License.
