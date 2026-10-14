import type { BotProfile } from "@t3tools/contracts";
import { BotIcon, BotOffIcon } from "lucide-react";

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
