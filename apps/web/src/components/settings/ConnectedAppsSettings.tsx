import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AppConnectionAddInput, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import {
  APP_CATALOG,
  type AppPreset,
  appPresetFieldDefault,
  buildAppConnectionInput,
  findAppPreset,
} from "@t3tools/shared/appCatalog";
import { ExternalLinkIcon, PlugIcon, PlusIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { ensureLocalApi } from "~/localApi";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { MARKETPLACE_CARD_CLASSNAME } from "../BotMarketplace";
import { LucideProjectIcon } from "../ProjectFavicon";
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

  const startSignIn = (next: SigningIn) => {
    setSigningIn(next);
    openExternal(next.authorizationUrl);
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
              <AppIcon presetId={connection.presetId} />
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
          environmentId={environmentId}
          redirectBaseUrl={redirectBaseUrl}
          onSignIn={startSignIn}
          onClose={() => {
            setAdding(false);
            refresh();
          }}
        />
      ) : null}
    </>
  );
}

function AppIcon(props: { presetId: string | null }) {
  const preset = props.presetId ? findAppPreset(props.presetId) : undefined;
  return preset ? (
    <LucideProjectIcon name={preset.icon.name} color={preset.icon.color} className="size-4" />
  ) : (
    <PlugIcon className="size-4 text-muted-foreground" />
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

function AddAppDialog(props: {
  environmentId: EnvironmentId;
  redirectBaseUrl: string | null;
  onSignIn: (signingIn: SigningIn) => void;
  onClose: () => void;
}) {
  const add = useAtomCommand(serverEnvironment.addAppConnection, { reportFailure: false });
  const [choice, setChoice] = useState<AppPreset | "custom" | null>(null);
  const [saving, setSaving] = useState(false);

  const connect = async (input: AppConnectionAddInput) => {
    if (saving) return;
    setSaving(true);
    const result = await add({
      environmentId: props.environmentId,
      input: props.redirectBaseUrl ? { ...input, redirectBaseUrl: props.redirectBaseUrl } : input,
    });
    setSaving(false);
    if (!reportResult(`Could not connect ${input.name}`, result)) return;
    if (result._tag === "Success" && result.value.signIn) {
      props.onSignIn({ ...result.value.signIn, name: input.name });
    }
    props.onClose();
  };

  const back = () => setChoice(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className={choice === null ? "sm:max-w-2xl" : "sm:max-w-lg"}>
        {choice === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Add an app</DialogTitle>
              <DialogDescription>
                Pick an app, or connect any app that offers an MCP server. Tokens and keys stay on
                this computer.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <AppCatalogPicker onChoose={setChoice} />
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={props.onClose}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : choice === "custom" ? (
          <CustomAppForm saving={saving} onConnect={connect} onBack={back} />
        ) : (
          <PresetAppForm preset={choice} saving={saving} onConnect={connect} onBack={back} />
        )}
      </DialogPopup>
    </Dialog>
  );
}

const CATALOG_CATEGORIES = [...new Set(APP_CATALOG.map((preset) => preset.category))];

function AppCatalogPicker(props: { onChoose: (choice: AppPreset | "custom") => void }) {
  return (
    <div className="flex flex-col gap-5">
      {CATALOG_CATEGORIES.map((category) => (
        <section key={category} className="flex flex-col gap-2">
          <h3 className="font-medium text-muted-foreground text-xs">{category}</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {APP_CATALOG.filter((preset) => preset.category === category).map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={MARKETPLACE_CARD_CLASSNAME}
                onClick={() => props.onChoose(preset)}
              >
                <LucideProjectIcon
                  name={preset.icon.name}
                  color={preset.icon.color}
                  className="mt-0.5 size-5"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium text-sm">{preset.name}</span>
                  <span className="text-muted-foreground text-xs">{preset.summary}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-muted-foreground text-xs">Other</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            className={MARKETPLACE_CARD_CLASSNAME}
            onClick={() => props.onChoose("custom")}
          >
            <PlugIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-sm">Custom</span>
              <span className="text-muted-foreground text-xs">
                Any app with an MCP server: a web address or a local command.
              </span>
            </span>
          </button>
        </div>
      </section>
    </div>
  );
}

interface AppFormProps {
  saving: boolean;
  onConnect: (input: AppConnectionAddInput) => Promise<void>;
  onBack: () => void;
}

function AppFormFooter(props: { saving: boolean; ready: boolean; onBack: () => void }) {
  return (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={props.onBack}>
        Back
      </Button>
      <Button type="submit" disabled={!props.ready || props.saving}>
        {props.saving ? "Connecting…" : "Connect"}
      </Button>
    </DialogFooter>
  );
}

function PresetAppForm(props: AppFormProps & { preset: AppPreset }) {
  const { preset } = props;
  const id = useId();
  const [name, setName] = useState(preset.name);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(preset.fields.map((field) => [field.key, appPresetFieldDefault(field)])),
  );
  const built = buildAppConnectionInput(preset, values, { name });

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if ("input" in built) void props.onConnect(built.input);
      }}
    >
      <DialogHeader>
        <DialogTitle>Add {preset.name}</DialogTitle>
        <DialogDescription>
          {preset.summary}
          {preset.note ? ` ${preset.note}` : ""}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              required
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {preset.fields.map((field, index) => (
            <div key={field.key} className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-${field.key}`}>
                {field.label}
                {field.optional ? " (optional)" : ""}
              </Label>
              <Input
                id={`${id}-${field.key}`}
                autoFocus={index === 0}
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                placeholder={field.placeholder}
                value={values[field.key] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field.key]: event.target.value }))
                }
              />
              {field.help ? <p className="text-muted-foreground text-xs">{field.help}</p> : null}
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() => openExternal(preset.docsUrl)}
            >
              <ExternalLinkIcon />
              {preset.name} setup guide
            </Button>
          </div>
        </div>
      </DialogPanel>
      <AppFormFooter saving={props.saving} ready={"input" in built} onBack={props.onBack} />
    </form>
  );
}

function CustomAppForm(props: AppFormProps) {
  const id = useId();
  const [kind, setKind] = useState<"http" | "stdio">("http");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [command, setCommand] = useState("");
  const [env, setEnv] = useState("");

  const words = command.trim().split(/\s+/).filter(Boolean);
  const ready = name.trim() !== "" && (kind === "http" ? url.trim() !== "" : words.length > 0);

  const submit = () => {
    if (!ready) return;
    const transport: AppConnectionAddInput["transport"] =
      kind === "http"
        ? { type: "http", url: url.trim(), ...(token.trim() ? { bearerToken: token.trim() } : {}) }
        : {
            type: "stdio",
            command: words[0] ?? "",
            args: words.slice(1),
            env: parseEnvironmentLines(env),
          };
    void props.onConnect({ name: name.trim(), transport });
  };

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Add a custom app</DialogTitle>
        <DialogDescription>
          MyBot connects to the app's MCP server and checks it works before saving. If the app asks
          you to sign in, MyBot opens its sign-in page in your browser.
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
      <AppFormFooter saving={props.saving} ready={ready} onBack={props.onBack} />
    </form>
  );
}
