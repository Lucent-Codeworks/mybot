import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PetId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
} from "@mybot/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PetHatchService from "../../../pets/PetHatchService.ts";
import * as PetLibrary from "../../../pets/PetLibrary.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PetsHandlers from "./handlers.ts";
import { PetsToolkit } from "./tools.ts";

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

const botId = ProjectId.make("project:bot");
const plainId = ProjectId.make("project:plain");
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

const bolt = {
  id: PetId.make("bolt"),
  displayName: "Bolt",
  description: "",
  kind: "picture",
  source: "builtin",
  builtIn: true,
  updatedAt: "2026-10-01T00:00:00.000Z",
} as const;

const setup = Effect.gen(function* () {
  const updates: Array<unknown> = [];
  const layerDependencies = Layer.mergeAll(
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
    Layer.mock(PetLibrary.PetLibrary)({
      list: () => Effect.succeed([bolt]),
    }),
    Layer.mock(PetHatchService.PetHatchService)({ jobs: () => Effect.succeed([]) }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          Option.some(
            id === botId
              ? record(id, { role: "Inbox", instructions: "Read mail.", autoReview: true })
              : record(id, null),
          ),
        ),
      update: (input) =>
        Effect.sync(() => {
          updates.push(input.bot);
          return record(input.projectId, input.bot ?? null);
        }),
    }),
  );
  const toolkit = yield* PetsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(PetsHandlers.layer).pipe(Layer.provide(layerDependencies)),
    ),
  );
  const call = <Name extends "pets_assign" | "pets_list">(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit
      .handle(name, params)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
  return { updates, call };
});

it.effect("pets_list returns the pets and hatch jobs", () =>
  Effect.gen(function* () {
    const { call } = yield* setup;
    const result = yield* call("pets_list", {});
    expect(result.at(-1)?.result).toEqual({ pets: [bolt], hatchJobs: [] });
  }),
);

it.effect("pets_assign sets the pet on a bot and keeps its other fields", () =>
  Effect.gen(function* () {
    const { call, updates } = yield* setup;
    yield* call("pets_assign", { projectId: botId, petId: PetId.make("bolt") });
    expect(updates).toEqual([
      { role: "Inbox", instructions: "Read mail.", autoReview: true, petId: "bolt" },
    ]);
    yield* call("pets_assign", { projectId: botId, petId: null });
    expect(updates.at(-1)).toMatchObject({ petId: null });
  }),
);

it.effect("pets_assign fails for an unknown pet or a project that is not a bot", () =>
  Effect.gen(function* () {
    const { call, updates } = yield* setup;
    const unknown = yield* call("pets_assign", { projectId: botId, petId: PetId.make("nope") });
    expect(unknown.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    const plain = yield* call("pets_assign", { projectId: plainId, petId: PetId.make("bolt") });
    expect(plain.at(-1)?.result).toMatchObject({ code: "invalid_request" });
    expect(updates).toEqual([]);
  }),
);
