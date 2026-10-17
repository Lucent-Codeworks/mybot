import { expect, it } from "@effect/vitest";
import {
  type ProjectCreateNewInput,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
} from "@mybot/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect("attributes a launched thread's first message to the calling thread", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const projectId = ProjectId.make("project");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const caller = {
      id: sourceThreadId,
      projectId,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    let launchedSender: ThreadId | undefined;
    const layerDependencies = Layer.mergeAll(
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launchedSender = input.initialMessage?.senderThreadId;
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: { id: input.threadId, projectId, modelSelection },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        scratchRoot: "/scratch",
        namedProjectsRoot: "/projects",
      }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-link-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", { title: "Audit", message: "Review the change" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    expect(result.at(-1)?.result).toMatchObject({ projectId, modelSelection });
    expect(launchedSender).toBe(sourceThreadId);
  }),
);

it.effect("starts a bot from just a title when workspaceRoot is omitted", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const createdProjectId = ProjectId.make("project:named");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: sourceThreadId,
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const named: Array<string> = [];
    const namedInputs: Array<ProjectCreateNewInput> = [];
    const registered: Array<string> = [];
    const createdProject = {
      id: createdProjectId,
      title: "Pinball Stats",
      workspaceRoot: "/projects/pinball-stats",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      deletedAt: null,
    };
    const layerDependencies = Layer.mergeAll(
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(Project.ProjectService)({
        create: (input) =>
          Effect.sync(() => {
            registered.push(input.workspaceRoot);
            return { ...createdProject, id: input.projectId, workspaceRoot: input.workspaceRoot };
          }),
        getById: (projectId) =>
          Effect.succeed(
            projectId === createdProjectId ? Option.some(createdProject) : Option.none(),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        scratchRoot: "/scratch",
        namedProjectsRoot: "/projects",
        createNamedProject: (input) =>
          Effect.sync(() => {
            named.push(input.name);
            namedInputs.push(input);
            return {
              projectId: createdProjectId,
              workspaceRoot: createdProject.workspaceRoot,
            };
          }),
      }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-named-project-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_project_create">>[1]) =>
      toolkit
        .handle("t3_project_create", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    const blankBot = { role: "", instructions: "" };

    const result = yield* handle({ title: "Pinball Stats", bot: blankBot });
    expect(result.at(-1)?.result).toMatchObject({
      id: createdProjectId,
      workspaceRoot: "/projects/pinball-stats",
    });
    expect(named).toEqual(["Pinball Stats"]);

    // A path still registers that folder, and never makes a named project.
    yield* handle({ title: "Existing", workspaceRoot: "/work/existing", bot: blankBot });
    expect(registered).toEqual(["/work/existing"]);

    // Fields this mode cannot apply are rejected, not dropped.
    for (const extra of [{ scripts: [] }, { createWorkspaceRootIfMissing: true }]) {
      const rejected = yield* handle({ title: "Configured", bot: blankBot, ...extra });
      expect(rejected.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    }
    expect(named).toEqual(["Pinball Stats"]);

    // A bot is a named project with a profile and a model.
    const bot = { role: "Daily tech scout", instructions: "Check bookmarks." };
    const defaultModelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    yield* handle({ title: "Scout", bot, defaultModelSelection });
    expect(namedInputs.at(-1)).toEqual({ name: "Scout", bot, defaultModelSelection });
  }),
);

it.effect("refuses to create a project without a bot or to remove a bot", () =>
  Effect.gen(function* () {
    const providerInstanceId = ProviderInstanceId.make("codex");
    const caller = {
      id: ThreadId.make("source-thread"),
      projectId: ProjectId.make("project:caller"),
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    // Any call through to the services would die on these empty mocks.
    const layerDependencies = Layer.mergeAll(
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: caller.id,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(Project.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        scratchRoot: "/scratch",
        namedProjectsRoot: "/projects",
      }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-plain-project-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const refusal = {
      code: "invalid_request",
      message: "MyBot only has bots: give the project a bot profile.",
    };
    for (const params of [
      { title: "Plain" },
      { title: "Plain", bot: null },
      { title: "Plain", workspaceRoot: "/work/plain" },
    ]) {
      const result = yield* toolkit
        .handle("t3_project_create", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
      expect(result.at(-1)?.result).toMatchObject(refusal);
    }
    const unbot = yield* toolkit
      .handle("t3_project_update", { projectId: caller.projectId, bot: null })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    expect(unbot.at(-1)?.result).toMatchObject(refusal);
  }),
);

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  /** Makes the target project a bot whose configured model is this one. */
  readonly botModel?: { readonly instanceId: ProviderInstanceId; readonly model: string };
}) => {
  const projectId = ProjectId.make("project:client-target");
  // "claudeAgent" is the real default instance id for the Claude driver
  // (see `defaultInstanceIdForDriver`), so it resolves as enabled by default
  // under the project-scoped provider instance gate the launch path now runs.
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus",
  };
  const layerDependencies = Layer.mergeAll(
    ServerSettings.layerTest(
      input.botModel === undefined
        ? {}
        : {
            projectSettingsOverrides: {
              [projectId]: {
                defaultModelSelection: input.botModel,
                defaultRuntimeMode: "approval-required",
              },
            },
          },
    ),
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread: undefined,
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: input.runtimeModeCeiling,
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (launch) => {
        input.launched.push(launch);
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              modelSelection: launch.modelSelection,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: "/projects/client-target",
                defaultModelSelection: modelSelection,
                bot:
                  input.botModel === undefined ? null : { role: "Inbox triage", instructions: "" },
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      scratchRoot: "/scratch",
      namedProjectsRoot: "/projects",
    }),
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );
  return { projectId, modelSelection, dependencies: layerDependencies };
};

it.effect("a client launches at its ceiling with the project's default model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, modelSelection, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto-accept-edits",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const handle = (params: Parameters<typeof toolkit.handle<"t3_thread_launch">>[1]) =>
      toolkit
        .handle("t3_thread_launch", params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const result = yield* handle({ title: "Fix", projectId, message: "Fix the bug" });
    expect(result.at(-1)?.result).toMatchObject({ projectId, modelSelection });
    expect(launched[0]?.runtimeMode).toBe("auto-accept-edits");
    expect(launched[0]?.initialMessage?.senderThreadId).toBeUndefined();

    const escalated = yield* handle({ title: "Fix", projectId, runtimeMode: "full-access" });
    expect(escalated.at(-1)?.result).toMatchObject({ code: "runtime_mode_escalation_denied" });

    const untargeted = yield* handle({ title: "Fix" });
    expect(untargeted.at(-1)?.result).toMatchObject({ code: "target_required" });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("a handoff to another bot starts on that bot's model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const botModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
      botModel,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", { title: "Triage", projectId, message: "Sort my inbox" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({ projectId, modelSelection: botModel });
    // The caller may run at full access, but the bot asks before acting.
    expect(launched[0]?.runtimeMode).toBe("approval-required");
  }),
);

it("never lets an agent grant Auto Review, and drops it when an agent rewrites the rules", () => {
  const reviewed = { role: "Inbox", instructions: "Only read mail.", autoReview: true };
  expect(
    ProjectHandlers.withoutAgentAutoReview(
      { ...reviewed, instructions: "x", autoReview: true },
      null,
    ),
  ).toEqual({ role: "Inbox", instructions: "x" });
  expect(
    ProjectHandlers.withoutAgentAutoReview(
      { role: "Mail", instructions: "Only read mail." },
      reviewed,
    ),
  ).toEqual({ role: "Mail", instructions: "Only read mail.", autoReview: true });
  expect(
    ProjectHandlers.withoutAgentAutoReview(
      { role: "Inbox", instructions: "Send anything." },
      reviewed,
    ),
  ).toEqual({ role: "Inbox", instructions: "Send anything." });
  expect(ProjectHandlers.withoutAgentAutoReview(null, reviewed)).toBeNull();
});

it.effect("agents can't delete the built-in MyBot, drop its flag, or give it to another bot", () =>
  Effect.gen(function* () {
    const providerInstanceId = ProviderInstanceId.make("codex");
    const myBotId = ProjectId.make("project:mybot");
    const otherId = ProjectId.make("project:other");
    const caller = {
      id: ThreadId.make("source-thread"),
      projectId: myBotId,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    const record = (id: ProjectId, bot: ProjectRecord["bot"]) =>
      ({
        id,
        title: "Bot",
        workspaceRoot: "/projects/bot",
        defaultModelSelection: null,
        bot,
        scripts: [],
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        deletedAt: null,
      }) satisfies ProjectRecord;
    const updates: Array<unknown> = [];
    const deletes: Array<ProjectId> = [];
    const layerDependencies = Layer.mergeAll(
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: { threadId: caller.id, providerSessionId: "session", providerInstanceId },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(Project.ProjectService)({
        getById: (id) =>
          Effect.succeed(
            Option.some(
              id === myBotId
                ? record(id, { role: "Your assistant", instructions: "", orchestrator: true })
                : record(id, { role: "Inbox", instructions: "" }),
            ),
          ),
        update: (input) =>
          Effect.sync(() => {
            updates.push(input.bot);
            return record(input.projectId, input.bot ?? null);
          }),
        delete: (input) =>
          Effect.sync(() => {
            deletes.push(input.projectId);
            return record(input.projectId, null);
          }),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        scratchRoot: "/scratch",
        namedProjectsRoot: "/projects",
      }),
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-builtin-mybot-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const call = <Name extends "t3_project_delete" | "t3_project_update">(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
    ) =>
      toolkit
        .handle(name, params)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

    const deleted = yield* call("t3_project_delete", { projectId: myBotId, force: true });
    expect(deleted.at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message: "MyBot is built in and can't be deleted.",
    });
    expect(deletes).toEqual([]);

    yield* call("t3_project_update", {
      projectId: myBotId,
      bot: { role: "Chief of staff", instructions: "" },
    });
    yield* call("t3_project_update", {
      projectId: otherId,
      bot: { role: "Inbox", instructions: "", orchestrator: true },
    });
    expect(updates).toEqual([
      { role: "Chief of staff", instructions: "", orchestrator: true },
      { role: "Inbox", instructions: "" },
    ]);
  }),
);
