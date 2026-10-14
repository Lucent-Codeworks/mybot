import { describe, expect, it } from "vite-plus/test";

import { resolveThreadReferenceCopyTarget } from "./threadReference.ts";

describe("resolveThreadReferenceCopyTarget", () => {
  it("copies the thread ID", () => {
    expect(resolveThreadReferenceCopyTarget({ threadId: "thread-1" })).toEqual({
      kind: "thread",
      value: "thread-1",
      clipboardTarget: "thread ID",
      successTitle: "Thread ID copied",
      failureTitle: "Failed to copy thread ID",
    });
  });
});
