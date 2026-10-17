import {
  BOT_TEMPLATE_CATEGORIES,
  BOT_TEMPLATES,
  type BotTemplate,
  type BotTemplateCategory,
} from "@mybot/shared/botTemplates";

export type BotMarketplaceFilter = "all" | "popular" | BotTemplateCategory;

export interface BotMarketplaceSection {
  readonly title: string;
  readonly templates: ReadonlyArray<BotTemplate>;
}

const POPULAR: BotMarketplaceSection = {
  title: "Popular",
  templates: BOT_TEMPLATES.filter((template) => template.popular),
};

const BY_CATEGORY: ReadonlyArray<BotMarketplaceSection> = BOT_TEMPLATE_CATEGORIES.map(
  (category) => ({
    title: category,
    templates: BOT_TEMPLATES.filter((template) => template.category === category),
  }),
).filter((section) => section.templates.length > 0);

/** The category list beside the templates, in order, with how many bots each holds. */
export const BOT_MARKETPLACE_FILTERS: ReadonlyArray<{
  value: BotMarketplaceFilter;
  label: string;
  count: number;
}> = [
  { value: "all", label: "All bots", count: BOT_TEMPLATES.length },
  { value: "popular", label: "Popular", count: POPULAR.templates.length },
  ...BY_CATEGORY.map((section) => ({
    value: section.title as BotTemplateCategory,
    label: section.title,
    count: section.templates.length,
  })),
];

const searchText = new Map(
  BOT_TEMPLATES.map((template) => [
    template.id,
    [
      template.name,
      template.role,
      template.summary,
      template.category,
      ...(template.keywords ?? []),
    ]
      .join("\n")
      .toLowerCase(),
  ]),
);

/**
 * The templates to show: every word of a search must match a template's name,
 * role, summary, category, or keywords (name and role matches first),
 * otherwise the chosen filter's sections. "All" shows Popular and then every
 * category.
 */
export function botMarketplaceSections(
  query: string,
  filter: BotMarketplaceFilter,
): ReadonlyArray<BotMarketplaceSection> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const matches = BOT_TEMPLATES.filter((template) =>
      words.every((word) => searchText.get(template.id)?.includes(word)),
    );
    const byTitle = (template: BotTemplate) =>
      words.some((word) => `${template.name}\n${template.role}`.toLowerCase().includes(word))
        ? 0
        : 1;
    const results = matches.toSorted((left, right) => byTitle(left) - byTitle(right));
    return results.length > 0 ? [{ title: "Results", templates: results }] : [];
  }
  if (filter === "all") return [POPULAR, ...BY_CATEGORY];
  if (filter === "popular") return [POPULAR];
  return BY_CATEGORY.filter((section) => section.title === filter);
}
