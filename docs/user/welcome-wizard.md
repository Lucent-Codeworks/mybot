# Welcome wizard

MyBot shows a setup flow when you open a new installation or connect to the
hosted app for the first time. Existing workspaces skip this flow.

## Connect your computers

Select one or more computers to set up. If you opened MyBot directly from a
server or the desktop app, that computer is already connected and selected.
It is identified by its name, which may differ from the device running your
browser.

You can add more computers before continuing:

- **Add a computer** connects directly to a server on your network or tailnet.
  Start the server with `mybot serve`, then run `mybot pair --tailscale` and paste
  the pairing link. You can also run `mybot serve --host <address>` and use
  `mybot pair` when the server is already reachable on your network.

Saved computers and computers discovered through MyBot Connect are selected by
default. Uncheck any you do not want to set up; this does not disconnect them.
Continue when your selected computers are connected. Setup then checks
agents across the selected computers.

If MyBot cannot confirm the workspace during startup, the setup flow shows
**Still connecting** instead of opening the app. Select **Reload** to try again.

If MyBot cannot read your saved settings, it shows **Could not read settings**.
Select **Retry** after storage becomes available. Setup does not replace
unreadable settings with defaults.

## Check your agents

MyBot checks each selected computer for Claude Code and Codex. If an agent is
not installed or signed in, select its action to open a terminal with the
correct command ready to run. Install uses the vendor's own installer, which
keeps **Update now** working in Settings. Other providers can be enabled in
Settings.

The setup terminal uses the home directory and environment configured for the
selected provider instance. Sensitive values remain redacted in Settings and
terminal metadata while the terminal process can use them.

Choose **Finish setup** when you are done. You can finish without configuring
agents, or return to an earlier step using the setup progress bar. When no bots
exist yet, MyBot opens on **Create your first bot**; choose **New bot** to make
one. See [Bots](./bots.md).
