import { isProviderDriverKind } from "@mybot/contracts";
import { acpRegistryClient } from "@mybot/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@mybot/provider-core/client";
import { cursorClient } from "@mybot/provider-cursor/client";
import { grokClient } from "@mybot/provider-grok/client";
import { museClient } from "@mybot/provider-muse/client";
import { openCodeClient } from "@mybot/provider-opencode/client";
import { piClient } from "@mybot/provider-pi/client";

/** The provider client definitions this mobile build ships. */
const providerClients = makeProviderClientRegistry([
  cursorClient,
  grokClient,
  museClient,
  openCodeClient,
  piClient,
  acpRegistryClient,
]);

/** The client definition for a driver kind, or `undefined` for drivers drawn by hand. */
export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}
