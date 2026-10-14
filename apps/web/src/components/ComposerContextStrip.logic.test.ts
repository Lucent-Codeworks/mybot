import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveEnvironmentOptionLabel,
  shouldShowComposerContextStrip,
  shouldShowEnvironmentIndicator,
} from "./ComposerContextStrip.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

describe("resolveEnvironmentOptionLabel", () => {
  it("prefers the primary environment's machine label", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: localEnvironmentId,
        runtimeLabel: "Julius's Mac mini",
        savedLabel: "Local environment",
      }),
    ).toBe("Julius's Mac mini");
  });

  it("falls back to 'This device' for generic primary labels", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: localEnvironmentId,
        runtimeLabel: "Local environment",
        savedLabel: "Local",
      }),
    ).toBe("This device");
  });

  it("keeps configured labels for non-primary environments", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: false,
        environmentId: remoteEnvironmentId,
        runtimeLabel: null,
        savedLabel: "Build box",
      }),
    ).toBe("Build box");
  });
});

describe("shouldShowEnvironmentIndicator", () => {
  it("shows the indicator whenever multiple environments are pickable", () => {
    expect(
      shouldShowEnvironmentIndicator({
        activeEnvironment: { isPrimary: true },
        canPickEnvironment: true,
      }),
    ).toBe(true);
  });

  it("shows a sole remote environment so the user knows where the project runs", () => {
    expect(
      shouldShowEnvironmentIndicator({
        activeEnvironment: { isPrimary: false },
        canPickEnvironment: false,
      }),
    ).toBe(true);
  });

  it("hides a sole primary (this-device) environment", () => {
    expect(
      shouldShowEnvironmentIndicator({
        activeEnvironment: { isPrimary: true },
        canPickEnvironment: false,
      }),
    ).toBe(false);
  });

  it("hides the indicator when the active environment is unknown", () => {
    expect(
      shouldShowEnvironmentIndicator({
        activeEnvironment: null,
        canPickEnvironment: false,
      }),
    ).toBe(false);
  });
});

describe("shouldShowComposerContextStrip", () => {
  it.each([false, true])(
    "honors the active-thread preference with resting controls %s",
    (hostsRestingComposerControls) => {
      const input = {
        isDraftHeroState: false,
        hasActiveProject: true,
        showEnvironmentIndicator: true,
        hostsRestingComposerControls,
      };
      expect(shouldShowComposerContextStrip({ ...input, persistInActiveThreads: false })).toBe(
        false,
      );
      expect(shouldShowComposerContextStrip({ ...input, persistInActiveThreads: true })).toBe(true);
    },
  );

  it("keeps the environment indicator visible", () => {
    expect(
      shouldShowComposerContextStrip({
        isDraftHeroState: true,
        persistInActiveThreads: false,
        hasActiveProject: true,
        showEnvironmentIndicator: true,
        hostsRestingComposerControls: false,
      }),
    ).toBe(true);
  });

  it("hides the strip when it has nothing to show", () => {
    expect(
      shouldShowComposerContextStrip({
        isDraftHeroState: true,
        persistInActiveThreads: false,
        hasActiveProject: true,
        showEnvironmentIndicator: false,
        hostsRestingComposerControls: false,
      }),
    ).toBe(false);
  });

  it("keeps the strip for visible resting composer controls", () => {
    expect(
      shouldShowComposerContextStrip({
        isDraftHeroState: true,
        persistInActiveThreads: false,
        hasActiveProject: true,
        showEnvironmentIndicator: false,
        hostsRestingComposerControls: true,
      }),
    ).toBe(true);
  });
});
