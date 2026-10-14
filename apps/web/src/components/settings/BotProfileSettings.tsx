import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { BotProfile, EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { BotIcon, BotOffIcon, SendIcon } from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "~/state/server";

import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * A project's bot profile. A plain project can become a bot, and a bot can
 * go back to being a plain project; its threads stay either way.
 */
export function BotProfileSettings(props: {
  bot: BotProfile | null;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  folder: string;
  disabled: boolean;
  onChange: (bot: BotProfile | null) => void;
}) {
  const { bot, disabled, onChange } = props;
  if (bot === null) {
    return (
      <SettingsSection title="Bot">
        <SettingsRow
          title="Make this a bot"
          description="Give this project a job and standing instructions that every conversation follows."
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onChange({ role: "", instructions: "" })}
            >
              <BotIcon />
              Make a bot
            </Button>
          }
        />
      </SettingsSection>
    );
  }
  return (
    <SettingsSection title="Bot">
      <SettingsRow
        title="Job"
        description="What this bot is for, in a few words."
        control={
          <Input
            key={bot.role}
            size="sm"
            className="w-full sm:w-64"
            aria-label="Bot job"
            maxLength={120}
            disabled={disabled}
            defaultValue={bot.role}
            onBlur={(event) => {
              const role = event.currentTarget.value.trim();
              if (role !== bot.role) onChange({ ...bot, role });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        }
      />
      <SettingsRow
        title="Instructions"
        description="Standing rules and context the bot receives in every conversation. Changes apply from the next message."
      >
        <div className="pb-3">
          <Textarea
            key={bot.instructions}
            rows={8}
            aria-label="Bot instructions"
            maxLength={20_000}
            disabled={disabled}
            defaultValue={bot.instructions}
            onBlur={(event) => {
              const instructions = event.currentTarget.value.trim();
              if (instructions !== bot.instructions) onChange({ ...bot, instructions });
            }}
          />
        </div>
      </SettingsRow>
      <BotMemoryRow environmentId={props.environmentId} folder={props.folder} disabled={disabled} />
      <BotTelegramRow environmentId={props.environmentId} projectId={props.projectId} />
      <SettingsRow
        title="Stop being a bot"
        description="Keeps the project and its threads, without the job and instructions."
        control={
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => onChange(null)}>
            <BotOffIcon />
            Make a plain project
          </Button>
        }
      />
    </SettingsSection>
  );
}

const MEMORY_FILE = "MEMORY.md";

/** The bot's memory file, which the bot keeps itself and the user can correct. */
function BotMemoryRow(props: { environmentId: EnvironmentId; folder: string; disabled: boolean }) {
  const memory = useProjectFileQuery(props.environmentId, props.folder, MEMORY_FILE);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, {
    label: "bot memory write",
  });
  const contents = memory.data?.contents ?? "";
  // A read the server rejected, usually a missing file, starts empty; saving creates it.
  const readable = memory.data !== null || memory.readError !== null;
  return (
    <SettingsRow
      title="Memory"
      description={
        memory.data?.truncated
          ? "This memory file is too large to edit here. Ask the bot to shorten it."
          : "What the bot remembers across conversations. It keeps this up to date itself; edit or remove anything here."
      }
    >
      <div className="pb-3">
        <Textarea
          key={contents}
          rows={8}
          aria-label="Bot memory"
          placeholder="Nothing remembered yet."
          disabled={props.disabled || !readable || memory.data?.truncated === true}
          defaultValue={contents}
          onBlur={(event) => {
            const next = event.currentTarget.value;
            if (next === contents) return;
            void writeFile({
              environmentId: props.environmentId,
              input: { cwd: props.folder, relativePath: MEMORY_FILE, contents: next },
            }).then(memory.refresh);
          }}
        />
      </div>
    </SettingsRow>
  );
}

/** Connects the bot to a Telegram bot so the user can message it from their phone. */
function BotTelegramRow(props: { environmentId: EnvironmentId; projectId: ProjectId }) {
  const statusAtom = serverEnvironment.botTelegramStatus({
    environmentId: props.environmentId,
    input: { projectId: props.projectId },
  });
  const result = useAtomValue(statusAtom);
  const refresh = useAtomRefresh(statusAtom);
  const status = Option.getOrNull(AsyncResult.value(result));
  const canOperate = useAtomValue(
    serverEnvironment.connectBotTelegram.permissionAtom(props.environmentId),
  );
  const connect = useAtomCommand(serverEnvironment.connectBotTelegram, {
    label: "bot telegram connect",
  });
  const disconnect = useAtomCommand(serverEnvironment.disconnectBotTelegram, {
    label: "bot telegram disconnect",
  });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action();
    setBusy(false);
    refresh();
  };

  if (status === null || !status.connected) {
    return (
      <SettingsRow
        title="Telegram"
        description="Message this bot from Telegram. Create a bot with @BotFather, then paste the token it gives you."
        control={
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = token.trim();
              if (!value) return;
              void run(async () => {
                const connected = await connect({
                  environmentId: props.environmentId,
                  input: { projectId: props.projectId, token: value },
                });
                if (connected._tag === "Success") setToken("");
              });
            }}
          >
            <Input
              size="sm"
              type="password"
              className="w-full sm:w-56"
              aria-label="Telegram bot token"
              placeholder="Bot token"
              autoComplete="off"
              disabled={!canOperate || busy}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <Button size="sm" variant="outline" type="submit" disabled={!canOperate || busy}>
              <SendIcon />
              Connect
            </Button>
          </form>
        }
      />
    );
  }
  const handle = status.username ? `@${status.username}` : "your Telegram bot";
  return (
    <SettingsRow
      title="Telegram"
      description={
        status.paired
          ? `Connected to ${handle}. Only your Telegram account can message it; /new starts a fresh conversation.`
          : `Send /start ${status.pairingCode ?? ""} to ${handle} in Telegram to pair your account.`
      }
      control={
        <div className="flex items-center gap-2">
          {status.paired ? null : (
            <Button size="sm" variant="outline" onClick={refresh}>
              Check again
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={!canOperate || busy}
            onClick={() =>
              void run(() =>
                disconnect({
                  environmentId: props.environmentId,
                  input: { projectId: props.projectId },
                }),
              )
            }
          >
            Disconnect
          </Button>
        </div>
      }
    />
  );
}
