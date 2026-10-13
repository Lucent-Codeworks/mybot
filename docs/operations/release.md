# Releases

> For maintainers.

Every push to `main` publishes a stable MyBot desktop release through
[`.github/workflows/release.yml`](../../.github/workflows/release.yml). It can also be started by
hand from the Actions tab (`workflow_dispatch`).

## What a run does

1. **Version.** `0.1.<run number>`, tagged `v0.1.<run number>`. Run numbers only increase, so
   every release is newer than the one before it, which is what the updater compares.
2. **JS bundle.** One job builds the server, web client, and Electron main once and shares them as
   the `js-bundle` artifact.
3. **Desktop builds.** [`release-desktop.yml`](../../.github/workflows/release-desktop.yml) runs
   once per target on GitHub-hosted runners: macOS arm64 and x64 (DMG + zip), Linux x64 and
   arm64 (AppImage + `.deb`), Windows x64 and arm64 (NSIS). The Linux jobs also build the CLI
   archive that the Windows jobs embed as the WSL runtime.
4. **GitHub Release.** Installers, blockmaps, and updater manifests (`latest*.yml`) are
   attached to a release marked latest. Per-arch macOS and Windows manifests are merged first,
   because electron-updater reads one manifest per platform.

Runs are serialized. A push that lands during a release waits for it; if several pile up, only
the newest waiting run is kept.

## Auto-updates

The desktop build bakes the update feed into the app from `GITHUB_REPOSITORY`, so installs update
from this repository's latest GitHub Release. The repository must stay public: electron-updater
reads releases without a token.

## Signing

Builds are unsigned unless the signing secrets are configured; `release-desktop.yml` detects them
per platform.

- **macOS** needs `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`, plus the `APPLE_TEAM_ID` variable and `MACOS_PROVISIONING_PROFILE`.
  macOS reports an unsigned download as "damaged". Run
  `xattr -dr com.apple.quarantine /Applications/MyBot.app` once after installing. Unsigned Mac
  builds also **do not auto-update**: macOS only installs updates for signed apps.
- **Windows** uses Azure Trusted Signing (`AZURE_*` secrets). Unsigned builds install and update,
  with a SmartScreen warning on first install.
- **Linux** is never signed.

## Side-by-side with T3 Code

MyBot uses its own app id (`com.lucentcodeworks.mybot`), data directory (`~/.mybot`), Electron
profile (`mybot`), URL scheme (`mybot://`), and Linux executable (`mybot`), so it installs and runs
next to T3 Code without sharing state. Keep these distinct when changing desktop identity code.
