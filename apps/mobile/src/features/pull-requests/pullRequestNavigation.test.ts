import { describe, expect, it } from "vite-plus/test";
import { nativePullRequestDestination } from "../../lib/pullRequestNavigation";
const context = { environmentId: "remote", projectId: "project" };
describe("native PR entry points", () => {
  it("keeps a thread link in its own environment", () => {
    expect(
      nativePullRequestDestination("https://github.com/org/repo/pull/12/files#diff", context),
    ).toEqual({ ...context, host: "github.com", repository: "org/repo", number: 12 });
  });
  it("leaves issues, unknown sites, and unscoped links to the external opener", () => {
    expect(
      nativePullRequestDestination("https://github.com/org/repo/issues/12", context),
    ).toBeNull();
    expect(
      nativePullRequestDestination("https://example.com/org/repo/pull/12", context),
    ).toBeNull();
    expect(nativePullRequestDestination("https://github.com/org/repo/pull/12", null)).toBeNull();
  });
});
