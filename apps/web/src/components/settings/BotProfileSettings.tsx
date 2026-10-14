import type { BotProfile, EnvironmentId } from "@t3tools/contracts";
import { BotIcon, BotOffIcon } from "lucide-react";

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
