import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import * as LocalRuntimes from "./LocalRuntimes.ts";
import { connectMcp } from "./mcpClient.ts";

// Downloads the pinned Node.js and uv for this computer into a temporary
// directory and starts a real app on each. Network-heavy, so it runs only with
// MYBOT_RUNTIME_E2E=1, for example after bumping a pin.
const enabled = HostProcess.Environment.defaultValue().MYBOT_RUNTIME_E2E === "1";

const apps = [
  {
    name: "Discord",
    transport: {
      type: "stdio" as const,
      command: "npx",
      args: ["-y", "mcp-discord"],
      env: { DISCORD_TOKEN: "fake" },
    },
  },
  {
    name: "Fetch",
    transport: { type: "stdio" as const, command: "uvx", args: ["mcp-server-fetch"] },
  },
];

it.layer(
  Layer.mergeAll(ProcessRunner.layer, FetchHttpClient.layer).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("LocalRuntimes with the pinned releases", (it) => {
  it.effect.skipIf(!enabled)(
    "starts npx and uvx apps on MyBot's own runtimes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcess.Platform;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "mybot-runtimes-e2e-" });
        const runtimes = yield* LocalRuntimes.makeLocalRuntimes({
          runtimesDir: path.join(dir, "runtimes"),
        });
        for (const app of apps) {
          const transport = yield* runtimes.prepare(app.transport);
          expect(transport.command.startsWith(dir)).toBe(true);
          const tools = yield* Effect.promise(async () => {
            const client = await connectMcp(transport, { timeoutMs: 180_000 }, platform);
            try {
              const page = await client.request("tools/list", {}, { timeoutMs: 60_000 });
              return Array.isArray(page.tools) ? page.tools.length : 0;
            } finally {
              await client.close();
            }
          });
          yield* Effect.logInfo(`${app.name}: ${tools} tools`);
          expect(tools, app.name).toBeGreaterThan(0);
        }
      }).pipe(Effect.scoped),
    600_000,
  );
});
