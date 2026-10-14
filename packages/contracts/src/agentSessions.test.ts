import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AgentSessionScanResult } from "./agentSessions.ts";

const decodeScanResult = Schema.decodeUnknownSync(AgentSessionScanResult);

const candidate = {
  path: "/projects/repo",
  title: "repo",
  sources: ["codex"],
  threadCount: 3,
  lastActiveAt: "2026-08-20T12:00:00.000Z",
  alreadyImported: false,
} as const;

describe("AgentSessionScanResult", () => {
  it("decodes candidates and ignores a git identity from older servers", () => {
    const result = decodeScanResult({
      candidates: [{ ...candidate, git: { remoteKey: null, repository: null } }],
      scannedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(result.candidates[0]).toEqual(candidate);
  });
});
