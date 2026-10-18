/**
 * Client storage keys were prefixed `t3code` (and a few just `t3`) before the
 * MyBot rename. These helpers move a stored value onto its `mybot` key the
 * first time it is seen, so users keep their state. When both keys exist the
 * `mybot` value wins, and the old key is removed either way.
 */

const LEGACY_PREFIXES = [
  ["t3code:", "mybot:"],
  ["t3code.", "mybot."],
  ["t3:", "mybot:"],
  ["t3.", "mybot."],
] as const;

/** The current key for a pre-rename key, or null when `key` is not a legacy key. */
export function renamedStorageKey(key: string): string | null {
  for (const [legacy, current] of LEGACY_PREFIXES) {
    if (key.startsWith(legacy)) return current + key.slice(legacy.length);
  }
  return null;
}

/** The `t3code` key a current `mybot` key was stored under, or null for other keys. */
export function legacyStorageKey(key: string): string | null {
  if (key.startsWith("mybot:")) return `t3code:${key.slice("mybot:".length)}`;
  if (key.startsWith("mybot.")) return `t3code.${key.slice("mybot.".length)}`;
  return null;
}

interface SyncStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Renames every legacy key in a Web Storage area. Run once at startup before
 * anything reads storage. Values that fail to write (quota) stay under the old
 * key and are retried on the next launch.
 */
export function migrateLegacyStorageKeys(storage: SyncStorage): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) keys.push(key);
  }
  for (const key of keys) {
    const current = renamedStorageKey(key);
    if (current === null) continue;
    const value = storage.getItem(key);
    try {
      if (value !== null && storage.getItem(current) === null) storage.setItem(current, value);
      storage.removeItem(key);
    } catch {
      // Over quota: keep the old key so the next launch can try again.
    }
  }
}

interface AsyncStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Reads `key`, moving a value still stored under its legacy key onto it first. */
export async function getItemMigratingLegacyKey(
  storage: AsyncStorage,
  key: string,
): Promise<string | null> {
  const value = await storage.getItem(key);
  const legacy = legacyStorageKey(key);
  if (value !== null || legacy === null) return value;
  const legacyValue = await storage.getItem(legacy);
  if (legacyValue === null) return null;
  await storage.setItem(key, legacyValue);
  await storage.removeItem(legacy);
  return legacyValue;
}

/** Removes `key` and any value still stored under its legacy key, so it cannot resurface. */
export async function removeItemWithLegacyKey(storage: AsyncStorage, key: string): Promise<void> {
  await storage.removeItem(key);
  const legacy = legacyStorageKey(key);
  if (legacy !== null) await storage.removeItem(legacy);
}
