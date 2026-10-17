import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@mybot/client-runtime/state/runtime";
import type { AppConnectionAddInput, EnvironmentId } from "@mybot/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ensureLocalApi } from "~/localApi";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { AddAppDialog } from "../apps/AppMarketplace";
import { AppLogo } from "../apps/AppLogo";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Shows a failed command as a toast; returns whether it succeeded. */
function reportResult(title: string, result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag === "Success") return true;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
  return false;
}

/** Apps (MCP servers) every bot can use through MyBot. */
export function ConnectedAppsSettings() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsSection id="connected-apps" title="Connected apps">
      {environmentId ? (
        <ConnectedAppsList environmentId={environmentId} />
      ) : (
        <SettingsRow title="Connected apps" description="Connect to MyBot to manage apps." />
      )}
    </SettingsSection>
  );
}

function openExternal(url: string) {
  ensureLocalApi()
    .shell.openExternal(url)
    .catch(() =>
      toastManager.add({ type: "error", title: "Could not open your browser", description: url }),
    );
}

/** A sign-in the user is finishing in their browser. */
interface SigningIn {
  readonly connectionId: string;
  readonly name: string;
  readonly authorizationUrl: string;
}

function ConnectedAppsList({ environmentId }: { environmentId: EnvironmentId }) {
  const listAtom = serverEnvironment.appConnections({ environmentId, input: {} });
  const result = useAtomValue(listAtom);
  const refresh = useAtomRefresh(listAtom);
  const connections = Option.getOrNull(AsyncResult.value(result))?.connections ?? [];
  const canOperate = useAtomValue(serverEnvironment.addAppConnection.permissionAtom(environmentId));
  const redirectBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const remove = useAtomCommand(serverEnvironment.removeAppConnection, { reportFailure: false });
  const signIn = useAtomCommand(serverEnvironment.signInAppConnection, { reportFailure: false });
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<SigningIn | null>(null);
  const add = useAtomCommand(serverEnvironment.addAppConnection, { reportFailure: false });
  const [saving, setSaving] = useState(false);

  const startSignIn = (next: SigningIn) => {
    setSigningIn(next);
    openExternal(next.authorizationUrl);
  };

  const connect = async (input: AppConnectionAddInput) => {
    if (saving) return;
    setSaving(true);
    const result = await add({
      environmentId,
      input: redirectBaseUrl ? { ...input, redirectBaseUrl } : input,
    });
    setSaving(false);
    if (!reportResult(`Could not connect ${input.name}`, result)) return;
    if (result._tag === "Success" && result.value.signIn) {
      startSignIn({ ...result.value.signIn, name: input.name });
    }
    setAdding(false);
    refresh();
  };

  // Shown until the app is ready; the list may not include a just-added app yet.
  const pendingSignIn =
    signingIn &&
    connections.find((connection) => connection.id === signingIn.connectionId)?.status !== "ready"
      ? signingIn
      : null;

  // Sign-in finishes in another window; check again when the user comes back.
  useEffect(() => {
    if (!pendingSignIn) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [pendingSignIn, refresh]);

  return (
    <>
      <SettingsRow
        title="Apps for your bots"
        description="Connect apps such as your phone system, mail, or automations. Every bot can use their tools and asks before acting for you."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!canOperate}
            onClick={() => setAdding(true)}
          >
            <PlusIcon />
            Add app
          </Button>
        }
      />
      {pendingSignIn ? (
        <SettingsRow
          title={`Finish signing in to ${pendingSignIn.name} in your browser`}
          description="MyBot connects the app as soon as you approve it there."
          control={
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openExternal(pendingSignIn.authorizationUrl)}
              >
                Open sign-in page
              </Button>
              <Button size="sm" variant="outline" onClick={refresh}>
                Check again
              </Button>
            </div>
          }
        />
      ) : null}
      {connections.map((connection) => (
        <SettingsRow
          key={connection.id}
          title={
            <span className="flex items-center gap-2">
              <AppLogo presetId={connection.presetId} size="sm" />
              {connection.name}
            </span>
          }
          description={
            connection.status === "ready"
              ? `${connection.toolCount ?? 0} ${connection.toolCount === 1 ? "tool" : "tools"} · ${connection.target}`
              : connection.status === "needs-sign-in"
                ? `Sign in so your bots can use it · ${connection.target}`
                : connection.error
          }
          control={
            <div className="flex items-center gap-2">
              {connection.status === "needs-sign-in" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canOperate || !redirectBaseUrl || busy === connection.id}
                  onClick={async () => {
                    if (!redirectBaseUrl) return;
                    setBusy(connection.id);
                    const started = await signIn({
                      environmentId,
                      input: { id: connection.id, redirectBaseUrl },
                    });
                    setBusy(null);
                    if (!reportResult(`Could not sign in to ${connection.name}`, started)) return;
                    if (started._tag === "Success") {
                      startSignIn({
                        connectionId: connection.id,
                        name: connection.name,
                        authorizationUrl: started.value.authorizationUrl,
                      });
                    }
                  }}
                >
                  Sign in
                </Button>
              ) : connection.status === "error" ? (
                <Button size="sm" variant="outline" onClick={refresh}>
                  Retry
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={!canOperate || busy === connection.id}
                onClick={async () => {
                  setBusy(connection.id);
                  const removed = await remove({ environmentId, input: { id: connection.id } });
                  setBusy(null);
                  if (signingIn?.connectionId === connection.id) setSigningIn(null);
                  reportResult(`Could not remove ${connection.name}`, removed);
                  refresh();
                }}
              >
                Remove
              </Button>
            </div>
          }
        />
      ))}
      {adding ? (
        <AddAppDialog
          connections={connections}
          saving={saving}
          onConnect={connect}
          onOpenLink={openExternal}
          onClose={() => {
            setAdding(false);
            refresh();
          }}
        />
      ) : null}
    </>
  );
}
