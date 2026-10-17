import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
} from "@mybot/contracts";
import { acpRegistryClient } from "@mybot/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@mybot/provider-core/client";
import { cursorClient } from "@mybot/provider-cursor/client";
import { grokClient } from "@mybot/provider-grok/client";
import { museClient } from "@mybot/provider-muse/client";
import { openCodeClient } from "@mybot/provider-opencode/client";
import { piClient } from "@mybot/provider-pi/client";

/** The provider client definitions this web build ships, in presentation order. */
export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);
