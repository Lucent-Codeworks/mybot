import {
  OrchestratorMcpFailure,
  PetHatchInput,
  PetHatchJob,
  PetId,
  PetsListResult,
  ProjectId,
} from "@mybot/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PetHatchService from "../../../pets/PetHatchService.ts";
import * as PetLibrary from "../../../pets/PetLibrary.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PetsListTool = Tool.make("pets_list", {
  description:
    "List the user's pets (the small animated companions bots can wear) and any pets still being hatched. Use a pet's id with pets_assign.",
  // No `parameters`: McpServer refuses an empty Schema.Struct, and a refused
  // registration stalls server startup instead of failing it.
  success: PetsListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    PetLibrary.PetLibrary,
    PetHatchService.PetHatchService,
  ],
})
  .annotate(Tool.Title, "List pets")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PetsHatchTool = Tool.make("pets_hatch", {
  description:
    "Hatch a new pet with AI image generation. It runs in the background through Codex and takes a few minutes; poll pets_list for the job's status, then assign the finished pet with pets_assign.",
  parameters: PetHatchInput,
  success: PetHatchJob,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PetHatchService.PetHatchService,
  ],
})
  .annotate(Tool.Title, "Hatch a pet")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const PetsAssignTool = Tool.make("pets_assign", {
  description: "Give a bot a pet, or take its pet away with petId null. The project must be a bot.",
  parameters: Schema.Struct({
    projectId: ProjectId,
    petId: Schema.NullOr(PetId),
  }),
  success: Schema.Struct({ projectId: ProjectId, petId: Schema.NullOr(PetId) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
    PetLibrary.PetLibrary,
    Project.ProjectService,
  ],
})
  .annotate(Tool.Title, "Assign a pet to a bot")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const PetsToolkit = Toolkit.make(PetsListTool, PetsHatchTool, PetsAssignTool);
