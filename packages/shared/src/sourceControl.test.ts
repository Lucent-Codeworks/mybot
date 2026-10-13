import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  sourceControlRepositorySelector,
  detectSourceControlProviderFromRemoteUrl,
  getChangeRequestTerminologyForKind,
  isSshRemoteUrl,
  resolveChangeRequestPresentation,
} from "./sourceControl.ts";

describe("source control presentation", () => {
  it("uses pull request terminology for GitHub", () => {
    expect(getChangeRequestTerminologyForKind(SourceControlProviderKind.make("github"))).toEqual({
      shortLabel: "PR",
      singular: "pull request",
    });
  });

  it("falls back to generic change request copy for unknown providers", () => {
    expect(
      resolveChangeRequestPresentation({
        kind: SourceControlProviderKind.make("unknown"),
        name: "forge",
        baseUrl: "",
      }),
    ).toEqual(
      expect.objectContaining({
        shortName: "change request",
        longName: "change request",
      }),
    );
  });
});

describe("detectSourceControlProviderFromRemoteUrl", () => {
  it("detects GitHub and reads every other host as unknown", () => {
    expect(detectSourceControlProviderFromRemoteUrl("git@github.com:owner/repo.git")?.kind).toBe(
      "github",
    );
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.com/group/repo.git")?.kind,
    ).toBe("unknown");
  });

  it("preserves ports while classifying by hostname", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://github.acme.test:8443/owner/repo.git"),
    ).toEqual({
      kind: "github",
      name: "GitHub Self-Hosted",
      baseUrl: "https://github.acme.test:8443",
    });
    expect(
      detectSourceControlProviderFromRemoteUrl(
        "https://self-hosted.example.test:8443/group/repo.git",
      ),
    ).toEqual({
      kind: "unknown",
      name: "self-hosted.example.test:8443",
      baseUrl: "https://self-hosted.example.test:8443",
    });
  });

  it("does not reuse SSH ports for HTTPS provider URLs", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("ssh://git@github.example.test:24/owner/repo.git"),
    ).toEqual({
      kind: "github",
      name: "GitHub Self-Hosted",
      baseUrl: "https://github.example.test",
    });
    expect(
      detectSourceControlProviderFromRemoteUrl("ssh://git@code.example.test:24/team/project.git"),
    ).toEqual({
      kind: "unknown",
      name: "code.example.test",
      baseUrl: "https://code.example.test",
    });
  });

  it("matches self-hosted providers by complete DNS labels", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://github.example.com/owner/repo.git")?.kind,
    ).toBe("github");
  });

  it("does not match provider names embedded in unrelated DNS labels", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://notgithub.example.com/owner/repo.git")
        ?.kind,
    ).toBe("unknown");
  });
});

describe("isSshRemoteUrl", () => {
  it("recognises SCP-like SSH URLs with any SSH user prefix", () => {
    expect(isSshRemoteUrl("git@github.com:owner/repo.git")).toBe(true);
    expect(isSshRemoteUrl("gitlab@gitlab.example.com:group/project.git")).toBe(true);
    expect(isSshRemoteUrl("deploy@bitbucket.org:workspace/repo.git")).toBe(true);
  });

  it("recognises ssh:// URLs with any case", () => {
    expect(isSshRemoteUrl("ssh://git@gitlab.example.com/group/project.git")).toBe(true);
    expect(isSshRemoteUrl("ssh://git@gitlab.example.com:22/group/project.git")).toBe(true);
    expect(isSshRemoteUrl("SSH://git@gitlab.example.com/group/project.git")).toBe(true);
    expect(isSshRemoteUrl("SsH://git@gitlab.example.com/group/project.git")).toBe(true);
  });

  it("returns false for HTTPS, local paths, and SCP-like paths without a colon", () => {
    expect(isSshRemoteUrl("https://gitlab.example.com/group/project.git")).toBe(false);
    expect(isSshRemoteUrl("/home/user/repos/project")).toBe(false);
    expect(isSshRemoteUrl("")).toBe(false);
    expect(isSshRemoteUrl("deploy@github.com/project/repo")).toBe(false);
  });
});

it("puts owner and name back together for an identity recorded before displayName", () => {
  const selector = sourceControlRepositorySelector({
    provider: "github",
    owner: "t3tools",
    name: "t3code",
  });
  expect(selector).toBe("t3tools/t3code");
});

it("names nothing for a project with no remote to name it by", () => {
  expect(sourceControlRepositorySelector(null)).toBeNull();
  expect(sourceControlRepositorySelector({ provider: "github" })).toBeNull();
});
