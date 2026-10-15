import {
  APP_CATALOG,
  APP_CATEGORIES,
  type AppCategory,
  type AppPreset,
  findAppPreset,
} from "@t3tools/shared/appCatalog";

export type MarketplaceFilter = "all" | "popular" | AppCategory;

export interface MarketplaceSection {
  readonly title: string;
  readonly presets: ReadonlyArray<AppPreset>;
}

const POPULAR: MarketplaceSection = {
  title: "Popular",
  presets: APP_CATALOG.filter((preset) => preset.popular),
};

const BY_CATEGORY: ReadonlyArray<MarketplaceSection> = APP_CATEGORIES.map((category) => ({
  title: category,
  presets: APP_CATALOG.filter((preset) => preset.category === category),
})).filter((section) => section.presets.length > 0);

/** The chips above the catalog, in order. */
export const MARKETPLACE_FILTERS: ReadonlyArray<{ value: MarketplaceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "popular", label: "Popular" },
  ...BY_CATEGORY.map((section) => ({
    value: section.title as AppCategory,
    label: section.title,
  })),
];

const searchText = new Map(
  APP_CATALOG.map((preset) => [
    preset.id,
    [preset.name, preset.summary, preset.category, ...(preset.keywords ?? [])]
      .join("\n")
      .toLowerCase(),
  ]),
);

/**
 * The catalog to show: every word of a search must match a preset's name,
 * summary, category, or keywords (names first), otherwise the chosen filter's
 * sections. "All" shows Popular and then every category.
 */
export function marketplaceSections(
  query: string,
  filter: MarketplaceFilter,
): ReadonlyArray<MarketplaceSection> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const matches = APP_CATALOG.filter((preset) =>
      words.every((word) => searchText.get(preset.id)?.includes(word)),
    );
    const byName = (preset: AppPreset) =>
      words.some((word) => preset.name.toLowerCase().includes(word)) ? 0 : 1;
    const results = matches.toSorted((left, right) => byName(left) - byName(right));
    return results.length > 0 ? [{ title: "Results", presets: results }] : [];
  }
  if (filter === "all") return [POPULAR, ...BY_CATEGORY];
  if (filter === "popular") return [POPULAR];
  return BY_CATEGORY.filter((section) => section.title === filter);
}

/** Where a connection points: its host, possibly after "Preset name · ". */
const targetHost = (target: string) => target.split(" · ").at(-1) ?? target;

const hostOf = (preset: AppPreset | undefined) => {
  const transport = preset?.transport({});
  return transport?.type === "http" && URL.canParse(transport.url)
    ? new URL(transport.url).host
    : null;
};

/**
 * The presets that already have a connection: by preset, by an aggregator's
 * server for the cards that go through it, and by host for a custom
 * connection to an aggregator.
 */
export function connectedPresetIds(
  connections: ReadonlyArray<{ readonly presetId: string | null; readonly target: string }>,
): ReadonlySet<string> {
  const connected = new Set<string>();
  const hosts = new Set(connections.map((connection) => targetHost(connection.target)));
  for (const connection of connections) {
    if (connection.presetId) connected.add(connection.presetId);
  }
  for (const preset of APP_CATALOG) {
    if (!preset.via) continue;
    const aggregatorHost = hostOf(findAppPreset(preset.via));
    if (connected.has(preset.via) || (aggregatorHost && hosts.has(aggregatorHost))) {
      connected.add(preset.via);
      connected.add(preset.id);
    }
  }
  return connected;
}

const VIA_LABEL = { composio: "Via Composio" } as const;

const CONNECTION_LABEL = {
  "sign-in": "Sign in",
  "api-key": "API key",
  local: "Runs on this computer",
  open: "No sign-in",
} as const;

/** How the app connects, as a short badge. */
export const connectionLabel = (preset: AppPreset): string =>
  preset.via ? VIA_LABEL[preset.via] : CONNECTION_LABEL[preset.connection];

const RUNTIME_NAME = { node: "Node.js", uv: "uv", docker: "Docker" } as const;

/** What a local app needs installed, or null. */
export const requirementLabel = (preset: AppPreset): string | null =>
  preset.requires ? `Needs ${RUNTIME_NAME[preset.requires]} on this computer` : null;
