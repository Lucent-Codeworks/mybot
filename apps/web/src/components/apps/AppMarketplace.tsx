import type { AppConnectionAddInput, AppConnectionSummary } from "@t3tools/contracts";
import {
  type AppPreset,
  type AppPresetField,
  appPresetFieldDefault,
  appPresetTarget,
  buildAppConnectionInput,
} from "@t3tools/shared/appCatalog";
import { ExternalLinkIcon, InfoIcon, SearchIcon } from "lucide-react";
import { useDeferredValue, useId, useMemo, useState } from "react";

import { MARKETPLACE_CARD_CLASSNAME } from "../BotMarketplace";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { AppLogo } from "./AppLogo";
import {
  connectedPresetIds,
  connectionLabel,
  MARKETPLACE_FILTERS,
  type MarketplaceFilter,
  marketplaceSections,
  requirementLabel,
} from "./appMarketplace.logic";

interface AddAppDialogProps {
  connections: ReadonlyArray<AppConnectionSummary>;
  saving: boolean;
  /** Adds the app; the dialog stays open if it fails. */
  onConnect: (input: AppConnectionAddInput) => Promise<void>;
  onOpenLink: (url: string) => void;
  onClose: () => void;
}

/** The app marketplace: pick an app from the catalog (or a custom one), then fill in its form. */
export function AddAppDialog(props: AddAppDialogProps) {
  const [choice, setChoice] = useState<AppPreset | "custom" | null>(null);
  const connected = useMemo(() => connectedPresetIds(props.connections), [props.connections]);
  const back = () => setChoice(null);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className={choice === null ? "sm:max-w-5xl" : "sm:max-w-lg"}>
        {choice === null ? (
          <AppPicker connected={connected} onChoose={setChoice} onCancel={props.onClose} />
        ) : choice === "custom" ? (
          <CustomAppForm saving={props.saving} onConnect={props.onConnect} onBack={back} />
        ) : (
          <PresetAppForm
            preset={choice}
            connected={connected.has(choice.id)}
            saving={props.saving}
            onConnect={props.onConnect}
            onOpenLink={props.onOpenLink}
            onBack={back}
            onClose={props.onClose}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function AppPicker(props: {
  connected: ReadonlySet<string>;
  onChoose: (choice: AppPreset | "custom") => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MarketplaceFilter>("all");
  const deferredQuery = useDeferredValue(query);
  const sections = useMemo(
    () => marketplaceSections(deferredQuery, filter),
    [deferredQuery, filter],
  );
  const searching = deferredQuery.trim() !== "";
  const chooseFilter = (value: MarketplaceFilter) => {
    setFilter(value);
    setQuery("");
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add an app</DialogTitle>
        <DialogDescription>
          Give your bots tools from the apps you use. Tokens and keys stay on this computer.
        </DialogDescription>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            id={`${id}-search`}
            aria-label="Search apps"
            autoFocus
            type="search"
            placeholder="Search apps, such as Gmail, Jira, or Stripe"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setFilter("all");
            }}
          />
        </InputGroup>
        {/* Narrow windows have no room for the category list beside the apps. */}
        <div className="sm:hidden">
          <Select
            value={searching ? null : filter}
            onValueChange={(value) => value && chooseFilter(value as MarketplaceFilter)}
          >
            <SelectTrigger aria-label="Category">
              <SelectValue placeholder="All apps" />
            </SelectTrigger>
            <SelectPopup>
              {MARKETPLACE_FILTERS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </DialogHeader>
      <DialogPanel>
        <div className="flex gap-5">
          <nav
            aria-label="Categories"
            className="sticky top-0 hidden w-52 shrink-0 self-start sm:block"
          >
            <ToggleGroup
              aria-label="Category"
              orientation="vertical"
              variant="nav"
              size="sm"
              className="w-full"
              value={searching ? [] : [filter]}
              onValueChange={(next) => {
                const value = next[0] as MarketplaceFilter | undefined;
                if (value) chooseFilter(value);
              }}
            >
              {MARKETPLACE_FILTERS.map((option) => (
                <Toggle key={option.value} value={option.value}>
                  <span className="truncate">{option.label}</span>
                  <span className="text-muted-foreground text-xs tabular-nums">{option.count}</span>
                </Toggle>
              ))}
            </ToggleGroup>
          </nav>
          <div className="flex min-w-0 flex-1 flex-col gap-5">
            {sections.map((section) => (
              <section key={section.title} className="flex flex-col gap-2">
                <h3 className="font-medium text-muted-foreground text-xs">{section.title}</h3>
                <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                  {section.presets.map((preset) => (
                    <AppCard
                      key={preset.id}
                      preset={preset}
                      connected={props.connected.has(preset.id)}
                      onChoose={() => props.onChoose(preset)}
                    />
                  ))}
                </div>
              </section>
            ))}
            <section className="flex flex-col gap-2">
              <h3 className="font-medium text-muted-foreground text-xs">
                {sections.length === 0 ? "Can't find it?" : "Other"}
              </h3>
              <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                <button
                  type="button"
                  className={MARKETPLACE_CARD_CLASSNAME}
                  onClick={() => props.onChoose("custom")}
                >
                  <AppLogo presetId={null} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium text-sm">Custom</span>
                    <span className="text-muted-foreground text-xs">
                      Connect any app with an MCP server, by web address or local command.
                    </span>
                  </span>
                </button>
              </div>
            </section>
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onCancel}>
          Cancel
        </Button>
      </DialogFooter>
    </>
  );
}

function AppBadges(props: { preset: AppPreset; connected: boolean; showKind?: boolean }) {
  const { preset } = props;
  return (
    <span className="flex flex-wrap gap-1">
      {props.connected ? (
        <Badge variant="success" size="sm">
          Connected
        </Badge>
      ) : null}
      {props.showKind === false ? null : (
        <Badge variant="outline" size="sm">
          {connectionLabel(preset)}
        </Badge>
      )}
      {preset.official ? null : (
        <Badge variant="secondary" size="sm">
          Community
        </Badge>
      )}
      {preset.platforms?.includes("darwin") ? (
        <Badge variant="outline" size="sm">
          macOS
        </Badge>
      ) : null}
    </span>
  );
}

function AppCard(props: { preset: AppPreset; connected: boolean; onChoose: () => void }) {
  const { preset } = props;
  return (
    <button type="button" className={MARKETPLACE_CARD_CLASSNAME} onClick={props.onChoose}>
      <AppLogo presetId={preset.id} />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="font-medium text-sm">{preset.name}</span>
        <span className="line-clamp-2 text-muted-foreground text-xs">{preset.summary}</span>
        <AppBadges preset={preset} connected={props.connected} />
      </span>
    </button>
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

function PresetAppForm(
  props: AppFormProps & {
    preset: AppPreset;
    connected: boolean;
    onOpenLink: (url: string) => void;
    onClose: () => void;
  },
) {
  const { preset } = props;
  // A card that goes through an aggregator connects the aggregator itself.
  const target = appPresetTarget(preset);
  const alreadyAvailable = preset.via !== undefined && props.connected;
  const id = useId();
  const [name, setName] = useState(target.name);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(target.fields.map((field) => [field.key, appPresetFieldDefault(field)])),
  );
  const built = buildAppConnectionInput(preset, values, { name });
  const requirement = requirementLabel(target);
  const setValue = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (alreadyAvailable) props.onClose();
        else if ("input" in built) void props.onConnect(built.input);
      }}
    >
      <DialogHeader>
        <div className="flex items-start gap-3">
          <AppLogo presetId={preset.id} size="lg" />
          <div className="flex min-w-0 flex-col gap-1">
            <DialogTitle>{preset.name}</DialogTitle>
            <DialogDescription>{preset.summary}</DialogDescription>
            <AppBadges preset={preset} connected={props.connected} />
          </div>
        </div>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {alreadyAvailable ? (
            <Alert variant="info">
              <InfoIcon aria-hidden />
              <AlertDescription>
                {preset.name} is already available through {target.name}. Ask a bot to use it;{" "}
                {target.name} asks you to approve {preset.name} the first time.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              {preset.note ? (
                <Alert variant="info">
                  <InfoIcon aria-hidden />
                  <AlertDescription>{preset.note}</AlertDescription>
                </Alert>
              ) : null}
              {target.steps ? (
                <div className="flex flex-col gap-1.5">
                  <p className="font-medium text-sm">Before you connect</p>
                  <ol className="flex list-decimal flex-col gap-1 ps-5 text-muted-foreground text-sm">
                    {target.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </div>
              ) : null}
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
              {target.fields.map((field, index) => (
                <PresetField
                  key={field.key}
                  id={`${id}-${field.key}`}
                  field={field}
                  autoFocus={index === 0}
                  value={values[field.key] ?? ""}
                  onChange={(value) => setValue(field.key, value)}
                  onOpenLink={props.onOpenLink}
                />
              ))}
              {requirement ? <p className="text-muted-foreground text-xs">{requirement}.</p> : null}
            </>
          )}
          <div>
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() => props.onOpenLink(preset.docsUrl)}
            >
              <ExternalLinkIcon />
              {/* A README is for developers; the form above already says how to set up. */}
              {new URL(preset.docsUrl).hostname === "github.com"
                ? "Technical details"
                : `${preset.name} setup guide`}
            </Button>
          </div>
        </div>
      </DialogPanel>
      {alreadyAvailable ? (
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onBack}>
            Back
          </Button>
          <Button type="submit">Done</Button>
        </DialogFooter>
      ) : (
        <AppFormFooter saving={props.saving} ready={"input" in built} onBack={props.onBack} />
      )}
    </form>
  );
}

function PresetField(props: {
  id: string;
  field: AppPresetField;
  autoFocus: boolean;
  value: string;
  onChange: (value: string) => void;
  onOpenLink: (url: string) => void;
}) {
  const { field } = props;
  const help = field.help ? <p className="text-muted-foreground text-xs">{field.help}</p> : null;

  if (field.kind === "toggle") {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={props.id}>{field.label}</Label>
          {help}
        </div>
        <Switch
          id={props.id}
          aria-label={field.label}
          checked={props.value === "true"}
          onCheckedChange={(checked) => props.onChange(checked ? "true" : "")}
        />
      </div>
    );
  }

  if (field.kind === "select") {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={props.id}>{field.label}</Label>
        <Select
          value={props.value}
          onValueChange={(value) => {
            if (value !== null) props.onChange(value);
          }}
        >
          <SelectTrigger id={props.id} aria-label={field.label}>
            <SelectValue>
              {field.options.find((option) => option.value === props.value)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {field.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {help}
      </div>
    );
  }

  const getAt = field.getAt;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={props.id}>
        {field.label}
        {field.optional ? " (optional)" : ""}
      </Label>
      <Input
        id={props.id}
        autoFocus={props.autoFocus}
        type={field.kind === "secret" ? "password" : "text"}
        autoComplete="off"
        placeholder={field.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {help}
      {getAt ? (
        <div>
          <Button type="button" variant="link" size="xs" onClick={() => props.onOpenLink(getAt)}>
            <ExternalLinkIcon />
            Get it from {new URL(getAt).hostname.replace(/^www\./, "")}
          </Button>
        </div>
      ) : null}
    </div>
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
        <div className="flex items-start gap-3">
          <AppLogo presetId={null} size="lg" />
          <div className="flex min-w-0 flex-col gap-1">
            <DialogTitle>Add a custom app</DialogTitle>
            <DialogDescription>
              MyBot connects to the app's MCP server and checks it works before saving. If the app
              asks you to sign in, MyBot opens its sign-in page in your browser.
            </DialogDescription>
          </div>
        </div>
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
              placeholder="My app"
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
