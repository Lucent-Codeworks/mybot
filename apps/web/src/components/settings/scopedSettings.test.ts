import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  listProjectOverrides,
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  resolveScopedSettingsTargets,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  selectScopedSettingsEnvironments,
} from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";

function environment(
  id: string,
  options: {
    connected?: boolean;
    loaded?: boolean;
    settings?: Partial<ServerSettings>;
    projectOverrides?: boolean;
  } = {},
) {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: {
      phase: options.connected === false ? ("offline" as const) : ("connected" as const),
    },
    serverConfig:
      options.loaded === false
        ? null
        : {
            settings: { ...DEFAULT_SERVER_SETTINGS, ...options.settings },
            environment: {
              capabilities: { projectSettingsOverrides: options.projectOverrides !== false },
            },
          },
  };
}

const laptop = environment("Laptop");
const server = environment("Server");
const offline = environment("Offline", { connected: false });
const loading = environment("Loading", { loaded: false });
const environments = [laptop, server, offline, loading];
const all = resolveSettingsScope({}, [], environments);
const named = resolveSettingsScope({ machine: server.environmentId }, [], environments);

const projectId = ProjectId.make("project");
const laptopProjectId = ProjectId.make("laptop-project");
const member = {
  id: projectId,
  environmentId: server.environmentId,
  title: "Project",
  workspaceRoot: "/repo",
  physicalProjectKey: `${server.environmentId}:/repo`,
  environmentLabel: server.label,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const laptopMember = {
  ...member,
  id: laptopProjectId,
  environmentId: laptop.environmentId,
  physicalProjectKey: `${laptop.environmentId}:/repo`,
  environmentLabel: laptop.label,
};
const group: SidebarProjectSnapshot = {
  ...member,
  projectKey: "project-group",
  displayName: "Project",
  memberProjects: [member, laptopMember],
  memberProjectRefs: [
    { environmentId: server.environmentId, projectId },
    { environmentId: laptop.environmentId, projectId: laptopProjectId },
  ],
  groupedProjectCount: 2,
  environmentPresence: "remote-only",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  remoteEnvironmentLabels: [server.label, laptop.label],
};
const project = resolveSettingsScope({ project: group.projectKey }, [group], environments);
const checkout = resolveSettingsScope(
  { project: group.projectKey, machine: server.environmentId, checkout: member.physicalProjectKey },
  [group],
  environments,
);

describe("scoped settings targets", () => {
  it("uses the named environment even when a different primary is available", () => {
    const selected = selectScopedSettingsEnvironments(named, environments, laptop.environmentId);
    expect(selected.environments).toEqual([server]);
    expect(selected.environment).toBe(server);
  });

  it("keeps an offline named environment selected without falling back to primary", () => {
    const scope = resolveSettingsScope({ machine: offline.environmentId }, [], environments);
    const selected = selectScopedSettingsEnvironments(scope, environments, laptop.environmentId);
    expect(selected.environments).toEqual([offline]);
    expect(selected.connectedEnvironments).toEqual([]);
    expect(selected.environment).toBeNull();
    expect(
      planScopedSettingsPatch(scope, environments, { enableProviderUpdateChecks: false }),
    ).toMatchObject({
      serverWrites: [],
      unavailableReason: "Connect Offline to save this setting.",
    });
  });

  it("prefers the selected primary as the aggregate representative without including disconnected targets", () => {
    const selected = selectScopedSettingsEnvironments(all, environments, server.environmentId);
    expect(selected.environment).toBe(server);
    expect(selected.environments).toEqual(environments);
    expect(selected.connectedEnvironments).toEqual([laptop, server]);
  });

  it("resolves each member's effective settings and source at project scope", () => {
    const overridden = environment("Server", {
      settings: {
        enableAgentDeviceAccess: false,
        projectSettingsOverrides: { [projectId]: { enableAgentDeviceAccess: true } },
      },
    });
    const targets = resolveScopedSettingsTargets(project, [laptop, overridden]);
    expect(
      targets.map((target) => [target.projectId, target.settings.enableAgentDeviceAccess]),
    ).toEqual([
      [projectId, true],
      [laptopProjectId, false],
    ]);
    expect(scopedSettingsSource(targets, ["enableAgentDeviceAccess"])).toBe("mixed");
    expect(scopedSettingsSource([targets[0]!], ["enableAgentDeviceAccess"])).toBe("project");
    expect(scopedSettingsSource(targets, ["enableProviderUpdateChecks"])).toBe("environment");
    expect(scopedSettingsAreMixed(targets, ["enableAgentDeviceAccess"])).toBe(true);
  });
});

describe("scoped settings writes", () => {
  it("isolates a formerly shared server preference to the named environment", async () => {
    const persistServer = vi.fn().mockResolvedValue({ _tag: "Success" });
    const persistClient = vi.fn();
    await persistScopedSettingsPatch(
      planScopedSettingsPatch(named, environments, { enableProviderUpdateChecks: false }),
      persistServer,
      persistClient,
    );
    expect(persistServer.mock.calls).toEqual([
      [
        {
          environmentId: server.environmentId,
          input: { patch: { enableProviderUpdateChecks: false } },
        },
      ],
    ]);
    expect(persistClient).not.toHaveBeenCalled();
  });

  it("writes an aggregate preference only to connected environments with loaded configuration", async () => {
    const persistServer = vi.fn().mockResolvedValue({ _tag: "Success" });
    const persistClient = vi.fn();
    await persistScopedSettingsPatch(
      planScopedSettingsPatch(all, environments, { enableProviderUpdateChecks: false }),
      persistServer,
      persistClient,
    );
    expect(persistServer.mock.calls.map(([input]) => input.environmentId)).toEqual([
      laptop.environmentId,
      server.environmentId,
    ]);
    expect(persistClient).not.toHaveBeenCalled();
  });

  describe("an environment that saves but drops keys it does not know", () => {
    // Laptop knows every key; Server is an older build that keeps its settings as they were.
    const upgradedLaptop = (saved: Partial<ServerSettings>) =>
      vi.fn(async ({ environmentId }: { environmentId: EnvironmentId }) => ({
        _tag: "Success" as const,
        value: {
          ...DEFAULT_SERVER_SETTINGS,
          ...(environmentId === laptop.environmentId ? saved : {}),
        },
      }));
    const outcome = async (
      plan: ReturnType<typeof planScopedSettingsPatch>,
      persistServer: ReturnType<typeof upgradedLaptop>,
    ) => {
      const result = await persistScopedSettingsPatch(plan, persistServer, vi.fn());
      return {
        saved: result.savedEnvironments.map(({ label }) => label),
        failed: result.failedEnvironments.map(({ label, message }) => ({ label, message })),
      };
    };
    const unsupported = [
      {
        label: server.label,
        message: "This environment does not support this setting. Update MyBot on it.",
      },
    ];

    it("reports a dropped toggle", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(all, environments, { enableDeviceSupport: true }),
          upgradedLaptop({ enableDeviceSupport: true }),
        ),
      ).toEqual({ saved: [laptop.label], failed: unsupported });
    });

    it("reports dropped text but accepts the server trimming it", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(all, environments, { addProjectBaseDirectory: " ~/code " }),
          upgradedLaptop({ addProjectBaseDirectory: "~/code" }),
        ),
      ).toEqual({ saved: [laptop.label], failed: unsupported });
    });

    it("reports a dropped key inside a project override", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(project, environments, { enableAgentDeviceAccess: true }),
          upgradedLaptop({
            projectSettingsOverrides: { [laptopProjectId]: { enableAgentDeviceAccess: true } },
          }),
        ),
      ).toEqual({ saved: [laptop.label], failed: unsupported });
    });

    it("reports a nested key dropped beside one that saved", async () => {
      const patch = { enableAgentDeviceAccess: true, enableAgentBrowserAccess: false };
      const persistServer = vi.fn(async ({ environmentId }: { environmentId: EnvironmentId }) => ({
        _tag: "Success" as const,
        value: {
          ...DEFAULT_SERVER_SETTINGS,
          projectSettingsOverrides:
            environmentId === laptop.environmentId
              ? { [laptopProjectId]: patch }
              : { [projectId]: { enableAgentDeviceAccess: true } },
        },
      }));
      expect(
        await outcome(planScopedSettingsPatch(project, environments, patch), persistServer),
      ).toEqual({ saved: [laptop.label], failed: unsupported });
    });

    it("accepts a write that matches what the environment already had", async () => {
      expect(
        await outcome(
          planScopedSettingsPatch(all, environments, { enableDeviceSupport: false }),
          upgradedLaptop({}),
        ),
      ).toEqual({ saved: [laptop.label, server.label], failed: [] });
    });
  });

  it("persists client keys locally at any scope alongside server keys", async () => {
    const persistServer = vi.fn().mockResolvedValue({ _tag: "Success" });
    const persistClient = vi.fn();
    await persistScopedSettingsPatch(
      planScopedSettingsPatch(named, environments, {
        wordWrap: false,
        enableProviderUpdateChecks: false,
      }),
      persistServer,
      persistClient,
    );
    expect(persistClient).toHaveBeenCalledExactlyOnceWith({ wordWrap: false });
    expect(persistServer).toHaveBeenCalledExactlyOnceWith({
      environmentId: server.environmentId,
      input: { patch: { enableProviderUpdateChecks: false } },
    });
  });

  it("writes project overrides into each member's entry on its environment", () => {
    const withExisting = environment("Server", {
      settings: {
        projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } },
      },
    });
    const plan = planScopedSettingsPatch(project, [laptop, withExisting], {
      enableAgentDeviceAccess: true,
    });
    expect(plan.unavailableReason).toBeNull();
    expect(plan.serverWrites).toEqual([
      {
        environmentId: server.environmentId,
        label: server.label,
        previous: expect.anything(),
        patch: {
          projectSettingsOverrides: {
            [projectId]: { enableAgentBrowserAccess: false, enableAgentDeviceAccess: true },
          },
        },
      },
      {
        environmentId: laptop.environmentId,
        label: laptop.label,
        previous: expect.anything(),
        patch: {
          projectSettingsOverrides: { [laptopProjectId]: { enableAgentDeviceAccess: true } },
        },
      },
    ]);
    expect(
      planScopedSettingsPatch(checkout, [laptop, server], { enableAgentDeviceAccess: true }),
    ).toMatchObject({
      serverWrites: [{ environmentId: server.environmentId }],
    });
  });

  it("scopes agent device access to projects while keeping hub and hosts environment-wide", () => {
    const plan = planScopedSettingsPatch(project, [laptop, server], {
      enableAgentDeviceAccess: true,
    });
    expect(plan.serverWrites.map((write) => write.patch)).toEqual([
      { projectSettingsOverrides: { [projectId]: { enableAgentDeviceAccess: true } } },
      { projectSettingsOverrides: { [laptopProjectId]: { enableAgentDeviceAccess: true } } },
    ]);
    for (const patch of [{ enableDeviceSupport: true }, { deviceHosts: [] }]) {
      expect(planScopedSettingsPatch(project, environments, patch).serverWrites).toEqual([]);
    }
  });

  it("refuses environment-wide keys and older servers at project scope", () => {
    expect(
      planScopedSettingsPatch(project, environments, { enableProviderUpdateChecks: false }),
    ).toMatchObject({
      serverWrites: [],
      unavailableReason: "This setting is environment-wide and cannot be overridden by a bot.",
    });
    const legacy = environment("Server", { projectOverrides: false });
    expect(
      planScopedSettingsPatch(checkout, [laptop, legacy], { enableAgentDeviceAccess: true }),
    ).toMatchObject({ serverWrites: [], unavailableReason: expect.stringContaining("update") });
  });

  it("clears overrides per member and removes an emptied entry", () => {
    const withOverrides = environment("Server", {
      settings: {
        projectSettingsOverrides: {
          [projectId]: { enableAgentDeviceAccess: true, enableAgentBrowserAccess: false },
        },
      },
    });
    const plan = planScopedSettingsClear(
      checkout,
      [laptop, withOverrides],
      ["enableAgentDeviceAccess"],
    );
    expect(plan.serverWrites).toEqual([
      {
        environmentId: server.environmentId,
        label: server.label,
        previous: expect.anything(),
        patch: { projectSettingsOverrides: { [projectId]: { enableAgentBrowserAccess: false } } },
      },
    ]);
    expect(
      planScopedSettingsClear(
        checkout,
        [laptop, withOverrides],
        ["enableAgentDeviceAccess", "enableAgentBrowserAccess"],
      ).serverWrites[0]?.patch,
    ).toEqual({ projectSettingsOverrides: { [projectId]: null } });
  });

  it("never substitutes an environment-default write for an invalid scope", () => {
    const scope = resolveSettingsScope({ machine: "removed" }, [group], environments);
    const plan = planScopedSettingsPatch(scope, environments, { enableAgentBrowserAccess: false });
    expect(plan.serverWrites).toEqual([]);
    expect(plan.hasClientWrite).toBe(false);
    expect(plan.unavailableReason).not.toBeNull();
  });

  it("waits for every target and identifies both RPC failures and rejected writes", async () => {
    const third = environment("Third");
    const fourth = environment("Fourth");
    const selected = [...environments, third, fourth];
    const scope = resolveSettingsScope({}, [], selected);
    const persistServer = vi
      .fn()
      .mockResolvedValueOnce({ _tag: "Success" })
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: "settings:write",
            message: "This connection lacks permission to change settings.",
          }),
        ),
      })
      .mockRejectedValueOnce(new Error("Disconnected during save"))
      .mockResolvedValueOnce({ _tag: "Success" });
    const result = await persistScopedSettingsPatch(
      planScopedSettingsPatch(scope, selected, { enableAgentBrowserAccess: false }),
      persistServer,
      vi.fn(),
    );
    expect(result.savedEnvironmentCount).toBe(2);
    expect(result.savedEnvironments.map(({ label }) => label)).toEqual([
      laptop.label,
      fourth.label,
    ]);
    expect(result.failedEnvironments.map(({ message }) => message)).toEqual([
      "This connection lacks permission to change settings.",
      "Disconnected during save",
    ]);
    expect(result.failedEnvironments.map(({ label }) => label)).toEqual([
      server.label,
      third.label,
    ]);
    expect(persistServer).toHaveBeenCalledTimes(4);
  });
});

describe("scoped settings mixed values", () => {
  it("compares only requested settings across connected targets", () => {
    const changed = environment("Changed", { settings: { enableAgentBrowserAccess: false } });
    const targets = resolveScopedSettingsTargets(all, [laptop, changed]);
    expect(scopedSettingsAreMixed(targets, ["enableAgentBrowserAccess"])).toBe(true);
    expect(scopedSettingsAreMixed(targets, ["enableProviderUpdateChecks"])).toBe(false);
    expect(scopedSettingsAreMixed([], ["enableAgentBrowserAccess"])).toBe(false);
  });

  it("treats independently decoded equal nested settings as the same value", () => {
    const cleanup = { ...DEFAULT_SERVER_SETTINGS.storageCleanup, logsAfterDays: 14 };
    const first = environment("First", { settings: { storageCleanup: { ...cleanup } } });
    const second = environment("Second", { settings: { storageCleanup: { ...cleanup } } });
    const targets = resolveScopedSettingsTargets(all, [first, second]);
    expect(scopedSettingsAreMixed(targets, ["storageCleanup"])).toBe(false);
  });
});

describe("project overrides at environment scope", () => {
  const laptop = EnvironmentId.make("laptop");
  const desk = EnvironmentId.make("desk");
  const fleet = ProjectId.make("fleet");
  const t3 = ProjectId.make("t3");
  const environment = (
    environmentId: EnvironmentId,
    overrides: ServerSettings["projectSettingsOverrides"],
  ) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected" as const },
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, projectSettingsOverrides: overrides },
      environment: { capabilities: { projectSettingsOverrides: true } },
    },
  });

  it("lists only the projects that override the keys", () => {
    const entries = listProjectOverrides(
      [
        environment(laptop, {
          [fleet]: { enableAgentDeviceAccess: true, responseStreamingMode: "turn" },
          [t3]: { responseStreamingMode: "turn" },
        }),
        environment(desk, { [fleet]: { enableAgentDeviceAccess: false } }),
      ],
      ["enableAgentDeviceAccess"],
    );
    expect(entries).toEqual([
      { environmentId: laptop, projectId: fleet },
      { environmentId: desk, projectId: fleet },
    ]);
  });

  it("clears only those keys and drops entries that become empty", () => {
    const plan = planProjectOverridesClear(
      [
        environment(laptop, {
          [fleet]: { enableAgentDeviceAccess: true, responseStreamingMode: "turn" },
          [t3]: { enableAgentDeviceAccess: true },
        }),
      ],
      [
        { environmentId: laptop, projectId: fleet },
        { environmentId: laptop, projectId: t3 },
      ],
      ["enableAgentDeviceAccess"],
    );
    expect(plan.serverWrites).toEqual([
      {
        environmentId: laptop,
        label: laptop,
        previous: expect.anything(),
        patch: {
          projectSettingsOverrides: { [fleet]: { responseStreamingMode: "turn" }, [t3]: null },
        },
      },
    ]);
  });
});

describe("partial object patches at project scope", () => {
  it("completes a model selection field patch from the target's effective value", () => {
    const environmentId = EnvironmentId.make("laptop");
    const projectId = ProjectId.make("fleet");
    const selection = DEFAULT_SERVER_SETTINGS.textGenerationModelSelection;
    const plan = planScopedSettingsPatch(
      {
        kind: "project",
        group: {} as never,
        environmentId: null,
        label: "fleet",
        members: [{ id: projectId, environmentId } as never],
        environmentIds: [environmentId],
      },
      [
        {
          environmentId,
          label: "Laptop",
          connection: { phase: "connected" },
          serverConfig: {
            settings: DEFAULT_SERVER_SETTINGS,
            environment: { capabilities: { projectSettingsOverrides: true } },
          },
        },
      ],
      { textGenerationModelSelection: { model: "terse-model" } },
    );
    expect(plan.serverWrites[0]?.patch).toEqual({
      projectSettingsOverrides: {
        [projectId]: { textGenerationModelSelection: { ...selection, model: "terse-model" } },
      },
    });
  });

  it("keeps a null override for keys that can store null", () => {
    const environmentId = EnvironmentId.make("laptop");
    const projectId = ProjectId.make("fleet");
    const plan = planScopedSettingsPatch(
      {
        kind: "project",
        group: {} as never,
        environmentId: null,
        label: "fleet",
        members: [{ id: projectId, environmentId } as never],
        environmentIds: [environmentId],
      },
      [
        {
          environmentId,
          label: "Laptop",
          connection: { phase: "connected" },
          serverConfig: {
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              projectSettingsOverrides: { [projectId]: { enableAgentDeviceAccess: true } },
            },
            environment: { capabilities: { projectSettingsOverrides: true } },
          },
        },
      ],
      { defaultModelSelection: null },
    );
    expect(plan.serverWrites[0]?.patch).toEqual({
      projectSettingsOverrides: {
        [projectId]: { enableAgentDeviceAccess: true, defaultModelSelection: null },
      },
    });
  });
});

it("routes legacy model preference keys exclusively to the selected environment", () => {
  const patch = {
    favorites: [{ provider: ProviderInstanceId.make("codex"), model: "sol" }],
    providerModelPreferences: {},
  };
  const plan = planScopedSettingsPatch(named, environments, patch);
  expect(plan.clientPatch).toEqual({});
  expect(plan.hasClientWrite).toBe(false);
  expect(plan.serverWrites).toEqual([
    {
      environmentId: server.environmentId,
      label: server.label,
      previous: expect.anything(),
      patch,
    },
  ]);
});
