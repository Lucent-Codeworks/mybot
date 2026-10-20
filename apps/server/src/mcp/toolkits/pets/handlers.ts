import { OrchestratorMcpFailure, type PetError } from "@mybot/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PetHatchService from "../../../pets/PetHatchService.ts";
import * as PetLibrary from "../../../pets/PetLibrary.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { newCommandId, unavailable } from "../../threadAccess.ts";
import { PetsToolkit } from "./tools.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const petFailure = (error: PetError) => invalid(error.message);

export const layer = McpToolAccess.toLayer(PetsToolkit, {
  pets_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const library = yield* PetLibrary.PetLibrary;
      const hatch = yield* PetHatchService.PetHatchService;
      return { pets: yield* library.list(), hatchJobs: yield* hatch.jobs() };
    }),
  ),
  pets_hatch: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const hatch = yield* PetHatchService.PetHatchService;
      return yield* hatch.start(input).pipe(Effect.mapError(petFailure));
    }),
  ),
  pets_assign: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const projects = yield* Project.ProjectService;
      const project = Option.getOrUndefined(
        yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable)),
      );
      if (project === undefined) return yield* invalid("The project was not found.");
      if (!project.bot) return yield* invalid("Pets can only be assigned to a bot.");
      if (input.petId !== null) {
        const library = yield* PetLibrary.PetLibrary;
        if (!(yield* library.list()).some((pet) => pet.id === input.petId))
          return yield* invalid(`There is no pet "${input.petId}". Use pets_list to see them.`);
      }
      // A bot is replaced whole on update, so carry every other field over.
      yield* projects
        .update({
          projectId: input.projectId,
          bot: { ...project.bot, petId: input.petId },
          commandId: yield* newCommandId(),
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ProjectOperationError" ? unavailable() : invalid(error.message),
          ),
        );
      return { projectId: input.projectId, petId: input.petId };
    }),
  ),
});
