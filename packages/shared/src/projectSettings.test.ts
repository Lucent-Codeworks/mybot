import {
  DEFAULT_SERVER_SETTINGS,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelSelection } from "./model.ts";
import {
  clearProjectSettingsOverrides,
  hasProjectSettingsOverrides,
  resolveProjectSettings,
  withProjectSettingsOverrides,
} from "./projectSettings.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");

describe("resolveProjectSettings", () => {
  it("inherits every scopable key when the project has no overrides", () => {
    const resolved = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId);
    expect(resolved.settings).toBe(DEFAULT_SERVER_SETTINGS);
    for (const key of PROJECT_SCOPED_SERVER_SETTING_KEYS) {
      expect(resolved.sources[key]).toBe("environment");
    }
    expect(resolveProjectSettings(DEFAULT_SERVER_SETTINGS, null).settings).toBe(
      DEFAULT_SERVER_SETTINGS,
    );
  });

  it("ignores an override left undefined by a forward-compatible decode", () => {
    const resolved = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        defaultRuntimeMode: "full-access",
        projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: undefined } as never },
      },
      projectId,
    );
    expect(resolved.settings.defaultRuntimeMode).toBe("full-access");
    expect(resolved.sources.defaultRuntimeMode).toBe("environment");
    expect(
      hasProjectSettingsOverrides({
        projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: undefined } as never },
      }),
    ).toBe(false);
  });

  it("treats a null project like an absent one before the shell snapshot arrives", () => {
    // The mobile new-task flow resolves settings while its selected project is
    // still null; reading the aggregate's legacy fields off null crashed launch.
    expect(resolveProjectSettings(DEFAULT_SERVER_SETTINGS, null, null).settings).toBe(
      DEFAULT_SERVER_SETTINGS,
    );
  });

  it("applies overrides per key and reports their source", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      enableAgentDeviceAccess: true,
      sidebarAutoSettleAfterDays: 3,
      projectSettingsOverrides: {
        [projectId]: { enableAgentDeviceAccess: false, sidebarAutoSettleAfterDays: null },
      },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.enableAgentDeviceAccess).toBe(false);
    expect(resolved.settings.sidebarAutoSettleAfterDays).toBeNull();
    expect(resolved.settings.defaultRuntimeMode).toBe(settings.defaultRuntimeMode);
    expect(resolved.sources.enableAgentDeviceAccess).toBe("project");
    expect(resolved.sources.sidebarAutoSettleAfterDays).toBe("project");
    expect(resolved.sources.defaultRuntimeMode).toBe("environment");
    expect(resolveProjectSettings(settings, otherProjectId).settings.enableAgentDeviceAccess).toBe(
      true,
    );
  });

  it("keeps the environment text generation model when the override's provider is disabled", () => {
    const disabledSelection = createModelSelection(ProviderInstanceId.make("claudeAgent"), "opus");
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
        },
      },
      projectSettingsOverrides: {
        [projectId]: { textGenerationModelSelection: disabledSelection },
      },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.textGenerationModelSelection).toEqual(
      settings.textGenerationModelSelection,
    );
    expect(resolved.sources.textGenerationModelSelection).toBe("environment");
  });

  it("honours the aggregate's own fields only until the server has folded them", () => {
    const aggregateModel = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5");
    const project = { defaultModelSelection: aggregateModel };
    const unfolded = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: false },
      projectId,
      project,
    );
    expect(unfolded.settings.defaultModelSelection).toEqual(aggregateModel);
    expect(unfolded.sources.defaultModelSelection).toBe("project");
    // A stored override still beats the aggregate before the fold.
    const overridden = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsFolded: false,
        projectSettingsOverrides: { [projectId]: { defaultModelSelection: null } },
      },
      projectId,
      project,
    );
    expect(overridden.settings.defaultModelSelection).toBeNull();
    // After the fold a reset in the record wins over the stale aggregate.
    const folded = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true },
      projectId,
      project,
    );
    expect(folded.settings.defaultModelSelection).toBeNull();
    expect(folded.sources.defaultModelSelection).toBe("environment");
  });

  it("keeps the environment default model when the override's provider is disabled", () => {
    const disabledSelection = createModelSelection(ProviderInstanceId.make("claudeAgent"), "opus");
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
        },
      },
      projectSettingsOverrides: { [projectId]: { defaultModelSelection: disabledSelection } },
    });
    const resolved = resolveProjectSettings(settings, projectId);
    expect(resolved.settings.defaultModelSelection).toBeNull();
    expect(resolved.sources.defaultModelSelection).toBe("environment");
  });

  it("moves text generation off an instance the project turned off", () => {
    const codex = ProviderInstanceId.make("codex");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(codex, "gpt-5"),
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [codex]: { enabled: false } } },
      },
    };
    expect(
      resolveProjectSettings(settings, projectId).settings.textGenerationModelSelection.instanceId,
    ).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      resolveProjectSettings(settings, otherProjectId).settings.textGenerationModelSelection,
    ).toEqual(settings.textGenerationModelSelection);
  });

  it("falls back to a configured instance when every built-in one is off for the project", () => {
    const codex = ProviderInstanceId.make("codex");
    const codexWork = ProviderInstanceId.make("codex_work");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(codex, "gpt-5"),
      providerInstances: { [codexWork]: { driver: ProviderDriverKind.make("codex"), config: {} } },
      projectSettingsOverrides: {
        [projectId]: {
          providerInstances: {
            [codex]: { enabled: false },
            [ProviderInstanceId.make("claudeAgent")]: { enabled: false },
          },
        },
      },
    };
    expect(
      resolveProjectSettings(settings, projectId).settings.textGenerationModelSelection.instanceId,
    ).toBe(codexWork);
  });
});

describe("projectSettingsOverrides patches", () => {
  it("replaces a project's entry, removes it with null, and drops empty entries", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { enableAgentDeviceAccess: true, enableAgentBrowserAccess: false },
        [otherProjectId]: { enableAgentDeviceAccess: false },
      },
    });
    expect(hasProjectSettingsOverrides(first)).toBe(true);
    const replaced = applyServerSettingsPatch(first, {
      projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } },
    });
    expect(replaced.projectSettingsOverrides[projectId]).toEqual({
      enableAgentBrowserAccess: false,
    });
    expect(replaced.projectSettingsOverrides[otherProjectId]).toEqual({
      enableAgentDeviceAccess: false,
    });
    const emptied = applyServerSettingsPatch(replaced, {
      projectSettingsOverrides: { [projectId]: {} },
    });
    expect(emptied.projectSettingsOverrides[projectId]).toBeUndefined();
    const removed = applyServerSettingsPatch(replaced, {
      projectSettingsOverrides: { [projectId]: null },
    });
    expect(removed.projectSettingsOverrides).toEqual({
      [otherProjectId]: { enableAgentDeviceAccess: false },
    });
    expect(hasProjectSettingsOverrides(DEFAULT_SERVER_SETTINGS)).toBe(false);
  });

  it("derives the legacy per-key maps from the generic record", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { enableAgentDeviceAccess: true, enableAgentBrowserAccess: false },
        [otherProjectId]: { defaultProjectScripts: [] },
      },
    });
    expect(settings.projectAgentBrowserAccessOverrides).toEqual({ [projectId]: false });
    expect(settings.projectScriptOverrides).toEqual({ [otherProjectId]: [] });
  });

  it("translates legacy per-key patches into the generic record", () => {
    const written = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectScriptOverrides: { [projectId]: [] },
      projectAgentBrowserAccessOverrides: { [projectId]: false, [otherProjectId]: true },
    });
    expect(written.projectSettingsOverrides).toEqual({
      [projectId]: { defaultProjectScripts: [], enableAgentBrowserAccess: false },
      [otherProjectId]: { enableAgentBrowserAccess: true },
    });
    const cleared = applyServerSettingsPatch(written, {
      projectAgentBrowserAccessOverrides: { [projectId]: null, [otherProjectId]: null },
    });
    expect(cleared.projectSettingsOverrides).toEqual({
      [projectId]: { defaultProjectScripts: [] },
    });
  });

  it("lets a canonical entry win over a legacy map for the same project", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: true } },
    });
    // The canonical entry omits enableAgentBrowserAccess to clear it; the stale legacy
    // map in the same patch must not put it back.
    const next = applyServerSettingsPatch(current, {
      projectSettingsOverrides: { [projectId]: { defaultRuntimeMode: "approval-required" } },
      projectAgentBrowserAccessOverrides: { [projectId]: true, [otherProjectId]: false },
    });
    expect(next.projectSettingsOverrides).toEqual({
      [projectId]: { defaultRuntimeMode: "approval-required" },
      [otherProjectId]: { enableAgentBrowserAccess: false },
    });
  });

  it("builds replacement entries and clears individual keys", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectId]: { enableAgentDeviceAccess: true, enableAgentBrowserAccess: false },
      },
    });
    expect(clearProjectSettingsOverrides(settings, projectId, ["enableAgentDeviceAccess"])).toEqual(
      {
        enableAgentBrowserAccess: false,
      },
    );
    expect(
      clearProjectSettingsOverrides(settings, projectId, [
        "enableAgentDeviceAccess",
        "enableAgentBrowserAccess",
      ]),
    ).toBeNull();
    expect(
      clearProjectSettingsOverrides(settings, otherProjectId, ["enableAgentDeviceAccess"]),
    ).toBeNull();
    expect(withProjectSettingsOverrides(settings, projectId, null)).toEqual({});
    expect(
      withProjectSettingsOverrides(settings, otherProjectId, { defaultRuntimeMode: "auto" }),
    ).toEqual({
      ...settings.projectSettingsOverrides,
      [otherProjectId]: { defaultRuntimeMode: "auto" },
    });
  });
});
