import { BOT_TEMPLATES } from "@t3tools/shared/botTemplates";
import { iconNames } from "lucide-react/dynamic";
import { describe, expect, it } from "vite-plus/test";

import {
  BOT_MARKETPLACE_FILTERS,
  type BotMarketplaceFilter,
  botMarketplaceSections,
} from "./botMarketplace.logic";

const ids = (query: string, filter: BotMarketplaceFilter = "all") =>
  botMarketplaceSections(query, filter).flatMap((section) =>
    section.templates.map((template) => template.id),
  );

describe("bot marketplace icons", () => {
  it("names a Lucide icon for every template", () => {
    for (const template of BOT_TEMPLATES) {
      expect(iconNames, template.id).toContain(template.icon.name);
    }
  });
});

describe("botMarketplaceSections", () => {
  it("shows Popular first, then every category in order", () => {
    const titles = botMarketplaceSections("", "all").map((section) => section.title);
    expect(titles[0]).toBe("Popular");
    expect(titles.slice(1)).toEqual(BOT_MARKETPLACE_FILTERS.slice(2).map((filter) => filter.label));
    expect(ids("", "popular")).toContain("research-analyst");
    expect(ids("", "Engineering")).toContain("code-reviewer");
    expect(ids("", "Engineering")).not.toContain("research-analyst");
  });

  it("searches with every word, name and role matches first", () => {
    expect(ids("receipt")).toContain("expense-tracker");
    expect(ids("CODE review")[0]).toBe("code-reviewer");
    expect(ids("no such bot anywhere")).toEqual([]);
    expect(botMarketplaceSections("  ", "Money").map((section) => section.title)).toEqual([
      "Money",
    ]);
  });
});
