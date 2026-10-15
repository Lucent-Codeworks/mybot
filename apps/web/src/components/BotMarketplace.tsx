import { BOT_TEMPLATES, type BotTemplate } from "@t3tools/shared/botTemplates";
import { PlusIcon } from "lucide-react";

import { LucideProjectIcon } from "./ProjectFavicon";

const CATEGORIES = [...new Set(BOT_TEMPLATES.map((template) => template.category))];

const CARD_CLASSNAME =
  "flex w-full items-start gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The bot marketplace: ready-made bots by category, plus a blank one. */
export function BotMarketplace(props: { onChoose: (template: BotTemplate | null) => void }) {
  return (
    <div className="flex flex-col gap-5">
      <button type="button" className={CARD_CLASSNAME} onClick={() => props.onChoose(null)}>
        <PlusIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-sm">Start from scratch</span>
          <span className="text-muted-foreground text-xs">
            Give a bot its own name, job, and instructions.
          </span>
        </span>
      </button>
      {CATEGORIES.map((category) => (
        <section key={category} className="flex flex-col gap-2">
          <h3 className="font-medium text-muted-foreground text-xs">{category}</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {BOT_TEMPLATES.filter((template) => template.category === category).map((template) => (
              <button
                key={template.id}
                type="button"
                className={CARD_CLASSNAME}
                onClick={() => props.onChoose(template)}
              >
                <LucideProjectIcon
                  name={template.icon.name}
                  color={template.icon.color}
                  className="mt-0.5 size-5"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium text-sm">
                    {template.name}
                    <span className="font-normal text-muted-foreground"> · {template.role}</span>
                  </span>
                  <span className="text-muted-foreground text-xs">{template.summary}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
