import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { BotProfile, EnvironmentId, ProjectId } from "@mybot/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, SendIcon } from "lucide-react";
import { useState } from "react";

import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@mybot/client-runtime/state/runtime";

import { serverEnvironment } from "~/state/server";
import { toastManager } from "../ui/toast";

import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { BotMembersPicker } from "../BotMembersPicker";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useUpdateScopedSettings } from "./useScopedSettings";

/** A bot's profile: its job, instructions, memory and channels. */
export function BotProfileSettings(props: {
  bot: BotProfile;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  folder: string;
  disabled: boolean;
  onChange: (bot: BotProfile) => void;
}) {
  const { bot, disabled, onChange } = props;
  const navigate = useNavigate();
  return (
    <SettingsSection title={bot.members === undefined ? "Bot" : "Group chat"}>
      {bot.members === undefined ? null : (
        <SettingsRow
          title="Bots"
          description="The bots in this group chat. Changes apply from the next message."
        >
          <div className="pb-3">
            <BotMembersPicker
              environmentId={props.environmentId}
              groupId={props.projectId}
              value={bot.members}
              disabled={disabled}
              onChange={(members) => onChange({ ...bot, members })}
            />
          </div>
        </SettingsRow>
      )}
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
      <BotAutoReviewRow bot={bot} disabled={disabled} onChange={onChange} />
      <SettingsRow
        title="Routines"
        description="Work this bot does on a schedule or when a webhook fires. Ask the bot to set one up, or manage them here."
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void navigate({
                to: "/settings/scheduled-tasks",
                search: { environmentId: props.environmentId },
              })
            }
          >
            <CalendarClockIcon />
            Manage routines
          </Button>
        }
      />
      <BotMemoryRow environmentId={props.environmentId} folder={props.folder} disabled={disabled} />
      <BotTelegramRow environmentId={props.environmentId} projectId={props.projectId} />
    </SettingsSection>
  );
}

const MEMORY_FILE = "MEMORY.md";

/** The bot's memory file, which the bot keeps itself and the user can correct. */
function BotMemoryRow(props: { environmentId: EnvironmentId; folder: string; disabled: boolean }) {
  const memory = useProjectFileQuery(props.environmentId, props.folder, MEMORY_FILE);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
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
            }).then((result) => {
              memory.refresh();
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                const error = squashAtomCommandFailure(result);
                toastManager.add({
                  type: "error",
                  title: "Could not save the bot's memory",
                  description: error instanceof Error ? error.message : "An error occurred.",
                });
              }
            });
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
  const connect = useAtomCommand(serverEnvironment.connectBotTelegram, { reportFailure: false });
  const disconnect = useAtomCommand(serverEnvironment.disconnectBotTelegram, {
    reportFailure: false,
  });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (
    title: string,
    action: () => Promise<AtomCommandResult<unknown, unknown>>,
  ): Promise<boolean> => {
    setBusy(true);
    const result = await action();
    setBusy(false);
    refresh();
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
              void run("Could not connect Telegram", () =>
                connect({
                  environmentId: props.environmentId,
                  input: { projectId: props.projectId, token: value },
                }),
              ).then((connected) => {
                if (connected) setToken("");
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
              void run("Could not disconnect Telegram", () =>
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

/**
 * Auto Review needs approval requests to review, so turning it on also makes
 * the bot's new threads ask before acting.
 */
function BotAutoReviewRow(props: {
  bot: BotProfile;
  disabled: boolean;
  onChange: (bot: BotProfile) => void;
}) {
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      title="Auto Review"
      description="A reviewer model approves this bot's clearly safe actions on its own and asks you about the rest. Turning it on makes the bot's new conversations ask before acting."
      control={
        <Switch
          aria-label="Auto Review"
          disabled={props.disabled}
          checked={props.bot.autoReview === true}
          onCheckedChange={(autoReview) => {
            props.onChange({ ...props.bot, autoReview });
            if (autoReview) updateSettings({ defaultRuntimeMode: "approval-required" });
          }}
        />
      }
    />
  );
}
