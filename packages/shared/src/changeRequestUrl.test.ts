import { describe, expect, it } from "vite-plus/test";

import {
  changeRequestUrlFor,
  parseChangeRequestUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  siblingPullRequestUrl,
} from "./changeRequestUrl.ts";

describe("parseChangeRequestUrl", () => {
  it("reads a GitHub pull request, lower-casing the repository", () => {
    expect(parseChangeRequestUrl("https://github.com/T3Tools/T3Code/pull/123")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
  });

  it("reads a pull request on a GitHub Enterprise host", () => {
    expect(parseChangeRequestUrl("https://github.acme.test/platform/api/pull/7")).toEqual({
      host: "github.acme.test",
      repository: "platform/api",
      number: 7,
    });
  });

  it("reads a supported GitHub host with a middle DNS label", () => {
    expect(parseChangeRequestUrl("https://code.github.example.com/acme/web/pull/42")).toEqual({
      host: "code.github.example.com",
      repository: "acme/web",
      number: 42,
    });
    expect(
      pullRequestCandidateUrlFromReferenceAutolink(
        "https://code.github.example.com/acme/web/issues/42",
      ),
    ).toBe("https://code.github.example.com/acme/web/pull/42");
  });

  it("survives trailing segments, a trailing slash and a query string", () => {
    expect(parseChangeRequestUrl("https://github.com/t3tools/t3code/pull/123/files?w=1")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
    expect(parseChangeRequestUrl("https://github.com/t3tools/t3code/pull/123/")).toEqual({
      host: "github.com",
      repository: "t3tools/t3code",
      number: 123,
    });
  });

  it("claims nothing it cannot be sure of", () => {
    for (const link of [
      "https://github.com/t3tools/t3code/issues/123",
      "https://github.com/t3tools/t3code/commit/0a1b2c3",
      "https://github.com/t3tools/t3code",
      "https://github.com/t3tools/t3code/pull/abc",
      "https://gitlab.com/t3tools/t3code/-/issues/12",
      "https://blog.example.test/2026/updates/pull/3",
      "javascript:alert(1)//github.com/t3tools/t3code/pull/1",
      "not a url",
    ]) {
      expect(parseChangeRequestUrl(link), link).toBeNull();
    }
  });
});

describe("siblingPullRequestUrl", () => {
  it.each([
    ["https://github.com/pull/1/pull/42/files", "https://github.com/pull/1/pull/43"],

    ["https://github.com/acme/web/pull/42#discussion_r123", "https://github.com/acme/web/pull/43"],
    ["https://github.com/acme/web/pull/42/files?w=1", "https://github.com/acme/web/pull/43"],
    [
      "https://github.acme.test:8443/acme/web/pull/42/",
      "https://github.acme.test:8443/acme/web/pull/43",
    ],
  ])("builds a canonical sibling of %s", (url, expected) => {
    expect(siblingPullRequestUrl(url, 43)).toBe(expected);
  });
  it("rejects non-PR URLs and invalid numbers", () => {
    expect(siblingPullRequestUrl("https://github.com/acme/web/issues/42", 43)).toBeNull();
    expect(siblingPullRequestUrl("https://github.com/acme/web/pull/42", 0)).toBeNull();
  });
});
