import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AppConnectionAddInput, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { PlugIcon, PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
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

function ConnectedAppsList({ environmentId }: { environmentId: EnvironmentId }) {
  const listAtom = serverEnvironment.appConnections({ environmentId, input: {} });
  const result = useAtomValue(listAtom);
  const refresh = useAtomRefresh(listAtom);
  const connections = Option.getOrNull(AsyncResult.value(result))?.connections ?? [];
  const canOperate = useAtomValue(serverEnvironment.addAppConnection.permissionAtom(environmentId));
  const remove = useAtomCommand(serverEnvironment.removeAppConnection, { reportFailure: false });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  return (
    <>
      <SettingsRow
        title="Apps for your bots"
        description="Connect an app that offers an MCP server, such as your mail, calendar, or CRM. Every bot can use its tools and asks before acting for you."
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
      {connections.map((connection) => (
        <SettingsRow
          key={connection.id}
          title={
            <span className="flex items-center gap-2">
              <PlugIcon className="size-4 text-muted-foreground" />
              {connection.name}
            </span>
          }
          description={
            connection.error
              ? connection.error
              : `${connection.toolCount ?? 0} ${connection.toolCount === 1 ? "tool" : "tools"} · ${connection.target}`
          }
          control={
            <div className="flex items-center gap-2">
              {connection.error ? (
                <Button size="sm" variant="outline" onClick={refresh}>
                  Retry
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={!canOperate || removing === connection.id}
                onClick={async () => {
                  setRemoving(connection.id);
                  const removed = await remove({ environmentId, input: { id: connection.id } });
                  setRemoving(null);
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
          environmentId={environmentId}
          onClose={() => {
            setAdding(false);
            refresh();
          }}
        />
      ) : null}
    </>
  );
}

/** "KEY=value" lines to an environment record; blank lines are skipped. */
export function parseEnvironmentLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf("=");
    if (separator > 0) env[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1);
  }
  return env;
}

function AddAppDialog(props: { environmentId: EnvironmentId; onClose: () => void }) {
  const id = useId();
  const add = useAtomCommand(serverEnvironment.addAppConnection, { reportFailure: false });
  const [kind, setKind] = useState<"http" | "stdio">("http");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [command, setCommand] = useState("");
  const [env, setEnv] = useState("");
  const [saving, setSaving] = useState(false);

  const words = command.trim().split(/\s+/).filter(Boolean);
  const ready = name.trim() !== "" && (kind === "http" ? url.trim() !== "" : words.length > 0);

  const submit = async () => {
    if (!ready || saving) return;
    const transport: AppConnectionAddInput["transport"] =
      kind === "http"
        ? { type: "http", url: url.trim(), ...(token.trim() ? { bearerToken: token.trim() } : {}) }
        : {
            type: "stdio",
            command: words[0] ?? "",
            args: words.slice(1),
            env: parseEnvironmentLines(env),
          };
    setSaving(true);
    const result = await add({
      environmentId: props.environmentId,
      input: { name: name.trim(), transport },
    });
    setSaving(false);
    if (reportResult(`Could not connect ${name.trim()}`, result)) props.onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add an app</DialogTitle>
            <DialogDescription>
              MyBot connects to the app's MCP server and checks it works before saving. Tokens and
              keys stay on this computer.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-name`}>Name</Label>
                <Input
                  id={`${id}-name`}
                  autoFocus
                  required
                  maxLength={60}
                  placeholder="Gmail"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <ToggleGroup
                aria-label="Connection type"
                variant="segmented"
                value={[kind]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "http" || value === "stdio") setKind(value);
                }}
              >
                <Toggle value="http">Web address</Toggle>
                <Toggle value="stdio">Local command</Toggle>
              </ToggleGroup>
              {kind === "http" ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-url`}>MCP server URL</Label>
                    <Input
                      id={`${id}-url`}
                      type="url"
                      placeholder="https://example.com/mcp"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-token`}>Access token (optional)</Label>
                    <Input
                      id={`${id}-token`}
                      type="password"
                      autoComplete="off"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-command`}>Command</Label>
                    <Input
                      id={`${id}-command`}
                      placeholder="npx -y @example/mcp-server"
                      value={command}
                      onChange={(event) => setCommand(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${id}-env`}>Environment (optional)</Label>
                    <Textarea
                      id={`${id}-env`}
                      rows={3}
                      placeholder="API_KEY=..."
                      value={env}
                      onChange={(event) => setEnv(event.target.value)}
                    />
                  </div>
                </>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || saving}>
              {saving ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
