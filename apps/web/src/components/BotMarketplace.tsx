import type { BotTemplate } from "@t3tools/shared/botTemplates";
import { PlusIcon, SearchIcon, UsersIcon } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";

import {
  BOT_MARKETPLACE_FILTERS,
  type BotMarketplaceFilter,
  botMarketplaceSections,
} from "./botMarketplace.logic";
import { LucideProjectIcon } from "./ProjectFavicon";
import { Button } from "./ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "./ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

export const MARKETPLACE_CARD_CLASSNAME =
  "flex w-full items-start gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/**
 * The bot marketplace, as the New bot dialog's first step: ready-made bots by
 * category with search, plus a blank bot and a group chat.
 */
export function BotMarketplace(props: {
  onChoose: (template: BotTemplate | null) => void;
  onGroup: () => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<BotMarketplaceFilter>("all");
  const deferredQuery = useDeferredValue(query);
  const sections = useMemo(
    () => botMarketplaceSections(deferredQuery, filter),
    [deferredQuery, filter],
  );
  const searching = deferredQuery.trim() !== "";
  const chooseFilter = (value: BotMarketplaceFilter) => {
    setFilter(value);
    setQuery("");
  };
  // Starting blank leads the catalog; during a search it waits at the end.
  const startCards = (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-muted-foreground text-xs">
        {searching ? (sections.length === 0 ? "Can't find it?" : "Other") : "Start"}
      </h3>
      <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
        <button
          type="button"
          className={MARKETPLACE_CARD_CLASSNAME}
          onClick={() => props.onChoose(null)}
        >
          <PlusIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium text-sm">Start from scratch</span>
            <span className="text-muted-foreground text-xs">
              Give a bot its own name, job, and instructions.
            </span>
          </span>
        </button>
        <button type="button" className={MARKETPLACE_CARD_CLASSNAME} onClick={props.onGroup}>
          <UsersIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium text-sm">Group chat</span>
            <span className="text-muted-foreground text-xs">
              Talk to several bots at once; each answers in its own words.
            </span>
          </span>
        </button>
      </div>
    </section>
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>New bot</DialogTitle>
        <DialogDescription>
          Start from a ready-made bot, or describe your own. You can change everything later.
        </DialogDescription>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search bots"
            autoFocus
            type="search"
            placeholder="Search bots, such as meal planner, tutor, or invoices"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setFilter("all");
            }}
          />
        </InputGroup>
        {/* Narrow windows have no room for the category list beside the bots. */}
        <div className="sm:hidden">
          <Select
            value={searching ? null : filter}
            onValueChange={(value) => value && chooseFilter(value as BotMarketplaceFilter)}
          >
            <SelectTrigger aria-label="Category">
              <SelectValue placeholder="All bots" />
            </SelectTrigger>
            <SelectPopup>
              {BOT_MARKETPLACE_FILTERS.map((option) => (
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
                const value = next[0] as BotMarketplaceFilter | undefined;
                if (value) chooseFilter(value);
              }}
            >
              {BOT_MARKETPLACE_FILTERS.map((option) => (
                <Toggle key={option.value} value={option.value}>
                  <span className="truncate">{option.label}</span>
                  <span className="text-muted-foreground text-xs tabular-nums">{option.count}</span>
                </Toggle>
              ))}
            </ToggleGroup>
          </nav>
          <div className="flex min-w-0 flex-1 flex-col gap-5">
            {searching ? null : startCards}
            {sections.map((section) => (
              <section key={section.title} className="flex flex-col gap-2">
                <h3 className="font-medium text-muted-foreground text-xs">{section.title}</h3>
                <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                  {section.templates.map((template) => (
                    <BotTemplateCard
                      key={template.id}
                      template={template}
                      onChoose={() => props.onChoose(template)}
                    />
                  ))}
                </div>
              </section>
            ))}
            {searching ? startCards : null}
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

function BotTemplateCard(props: { template: BotTemplate; onChoose: () => void }) {
  const { template } = props;
  return (
    <button type="button" className={MARKETPLACE_CARD_CLASSNAME} onClick={props.onChoose}>
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
        <span className="line-clamp-2 text-muted-foreground text-xs">{template.summary}</span>
      </span>
    </button>
  );
}
