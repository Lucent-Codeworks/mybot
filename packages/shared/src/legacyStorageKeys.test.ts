import { describe, expect, it } from "vite-plus/test";

import {
  getItemMigratingLegacyKey,
  migrateLegacyStorageKeys,
  removeItemWithLegacyKey,
} from "./legacyStorageKeys.ts";

function memoryStorage(initial: Record<string, string>) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

function asyncStorage(initial: Record<string, string>) {
  const sync = memoryStorage(initial);
  return {
    items: sync.items,
    getItem: async (key: string) => sync.getItem(key),
    setItem: async (key: string, value: string) => sync.setItem(key, value),
    removeItem: async (key: string) => sync.removeItem(key),
  };
}

describe("migrateLegacyStorageKeys", () => {
  it("moves every legacy prefix onto its mybot key and leaves other keys alone", () => {
    const storage = memoryStorage({
      "t3code:theme": "dark",
      "t3code.renderMarkdown": "true",
      "t3:chatgpt-sharing-welcome:v1": "1",
      "t3.backgroundActivity.clientId": "client",
      "other:key": "kept",
    });

    migrateLegacyStorageKeys(storage);

    expect(Object.fromEntries(storage.items)).toEqual({
      "mybot:theme": "dark",
      "mybot.renderMarkdown": "true",
      "mybot:chatgpt-sharing-welcome:v1": "1",
      "mybot.backgroundActivity.clientId": "client",
      "other:key": "kept",
    });
  });

  it("keeps the mybot value when both keys exist and drops the legacy one", () => {
    const storage = memoryStorage({ "t3code:theme": "old", "mybot:theme": "new" });

    migrateLegacyStorageKeys(storage);

    expect(Object.fromEntries(storage.items)).toEqual({ "mybot:theme": "new" });
  });

  it("keeps the legacy key when the new value cannot be written", () => {
    const storage = memoryStorage({ "t3code:drafts": "draft" });
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };

    migrateLegacyStorageKeys(storage);

    expect(Object.fromEntries(storage.items)).toEqual({ "t3code:drafts": "draft" });
  });
});

describe("getItemMigratingLegacyKey", () => {
  it("moves a legacy value onto the new key on first read", async () => {
    const storage = asyncStorage({ "t3code.preferences": "{}" });

    expect(await getItemMigratingLegacyKey(storage, "mybot.preferences")).toBe("{}");
    expect(Object.fromEntries(storage.items)).toEqual({ "mybot.preferences": "{}" });
  });

  it("prefers the new key when both exist", async () => {
    const storage = asyncStorage({ "t3code.preferences": "old", "mybot.preferences": "new" });

    expect(await getItemMigratingLegacyKey(storage, "mybot.preferences")).toBe("new");
  });

  it("removes both keys so a legacy value cannot come back", async () => {
    const storage = asyncStorage({ "t3code.preferences": "old", "mybot.preferences": "new" });

    await removeItemWithLegacyKey(storage, "mybot.preferences");

    expect(await getItemMigratingLegacyKey(storage, "mybot.preferences")).toBeNull();
  });
});
