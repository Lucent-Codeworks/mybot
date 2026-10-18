import { migrateLegacyStorageKeys } from "@mybot/shared/legacyStorageKeys";

import { showBootError } from "./lib/bootError";

// Stores read their keys as soon as their modules load, so rename pre-MyBot
// `t3code:` keys before the app is imported.
for (const storage of ["localStorage", "sessionStorage"] as const) {
  try {
    migrateLegacyStorageKeys(window[storage]);
  } catch {
    // Storage can be blocked entirely; the app starts with defaults.
  }
}

// Bundled dev can move UI code into shared chunks. Load it only after this
// entry runs the React refresh preamble, and catch failures before React mounts.
void import("./main").then(({ startup }) => startup).catch(showBootError);
