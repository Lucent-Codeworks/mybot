import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  getItemMigratingLegacyKey,
  removeItemWithLegacyKey,
} from "@mybot/shared/legacyStorageKeys";
import * as SecureStore from "expo-secure-store";

const MobileSecureStorageOperation = Schema.Literals(["read", "write", "delete"]);

export class MobileSecureStorageError extends Schema.TaggedError<MobileSecureStorageError>()(
  "MobileSecureStorageError",
  {
    operation: MobileSecureStorageOperation,
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Mobile secure storage operation ${this.operation} failed for key ${this.key}.`;
  }
}

const secureStore = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

/**
 * Reads a `mybot.*` secure-store key, moving a value still stored under its
 * pre-rename `t3code.*` key onto it first. Use instead of `getItemAsync`.
 */
export const getSecureItem = (key: string) => getItemMigratingLegacyKey(secureStore, key);

/** Deletes a `mybot.*` key and its pre-rename `t3code.*` key. Use instead of `deleteItemAsync`. */
export const removeSecureItem = (key: string) => removeItemWithLegacyKey(secureStore, key);

export class MobileSecureStorage extends Context.Service<
  MobileSecureStorage,
  {
    readonly getItem: (key: string) => Effect.Effect<string | null, MobileSecureStorageError>;
    readonly setItem: (key: string, value: string) => Effect.Effect<void, MobileSecureStorageError>;
    readonly removeItem: (key: string) => Effect.Effect<void, MobileSecureStorageError>;
  }
>()("@mybot/mobile/persistence/MobileSecureStorage") {}

export const make = MobileSecureStorage.of({
  getItem: Effect.fn("MobileSecureStorage.getItem")((key) =>
    Effect.tryPromise({
      try: () => getSecureItem(key),
      catch: (cause) => new MobileSecureStorageError({ operation: "read", key, cause }),
    }),
  ),
  setItem: Effect.fn("MobileSecureStorage.setItem")((key, value) =>
    Effect.tryPromise({
      try: () => SecureStore.setItemAsync(key, value),
      catch: (cause) => new MobileSecureStorageError({ operation: "write", key, cause }),
    }),
  ),
  removeItem: Effect.fn("MobileSecureStorage.removeItem")((key) =>
    Effect.tryPromise({
      try: () => removeSecureItem(key),
      catch: (cause) => new MobileSecureStorageError({ operation: "delete", key, cause }),
    }),
  ),
});

export const layer = Layer.succeed(MobileSecureStorage, make);
