import { describe, expect, it } from "vite-plus/test";

import {
  connectedPresetIds,
  connectionLabel,
  MARKETPLACE_FILTERS,
  marketplaceSections,
} from "./appMarketplace.logic";
import { findAppPreset } from "@t3tools/shared/appCatalog";

const ids = (query: string, filter: Parameters<typeof marketplaceSections>[1] = "all") =>
  marketplaceSections(query, filter).flatMap((section) => section.presets.map((p) => p.id));

describe("marketplaceSections", () => {
  it("shows Popular first, then every category in order", () => {
    const titles = marketplaceSections("", "all").map((section) => section.title);
    expect(titles[0]).toBe("Popular");
    expect(titles.slice(1)).toEqual(MARKETPLACE_FILTERS.slice(2).map((filter) => filter.label));
    expect(ids("", "popular")).toContain("gmail");
    expect(ids("", "Phone & SMS")).toEqual(
      expect.arrayContaining(["dialpad", "telnyx", "telnyx-read-only", "twilio"]),
    );
    expect(ids("", "Phone & SMS")).not.toContain("gmail");
  });

  it("searches names, keywords, and categories with every word, names first", () => {
    expect(ids("jira")).toEqual(["atlassian"]);
    expect(ids("TEAMS")).toContain("outlook");
    expect(ids("phone sms")).toEqual(expect.arrayContaining(["dialpad", "twilio"]));
    expect(ids("notion")[0]).toBe("notion");
    expect(ids("no such app anywhere")).toEqual([]);
    expect(marketplaceSections("  ", "Automation").map((section) => section.title)).toEqual([
      "Automation",
    ]);
  });
});

describe("connectedPresetIds", () => {
  it("marks Google cards connected when Composio is", () => {
    const connected = connectedPresetIds([
      { presetId: "composio", target: "connect.composio.dev" },
    ]);
    expect(connected.has("gmail")).toBe(true);
    expect(connected.has("google-calendar")).toBe(true);
    expect(connected.has("zapier")).toBe(false);
  });

  it("matches a custom connection to Composio by host", () => {
    const connected = connectedPresetIds([{ presetId: null, target: "connect.composio.dev" }]);
    expect(connected.has("gmail")).toBe(true);
    expect(connected.has("composio")).toBe(true);
  });

  it("matches other apps by preset only", () => {
    const connected = connectedPresetIds([
      { presetId: "linear", target: "mcp.linear.app" },
      { presetId: null, target: "npx" },
    ]);
    expect([...connected]).toEqual(["linear"]);
  });
});

describe("connectionLabel", () => {
  it("names aggregator cards by the aggregator", () => {
    expect(connectionLabel(findAppPreset("gmail")!)).toBe("Via Composio");
    expect(connectionLabel(findAppPreset("twilio")!)).toBe("Runs on this computer");
  });
});
