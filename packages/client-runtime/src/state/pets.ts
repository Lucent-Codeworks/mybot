import { WS_METHODS } from "@mybot/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createPetEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pets:list",
      tag: WS_METHODS.petsList,
    }),
    listCodex: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pets:list-codex",
      tag: WS_METHODS.petsListCodex,
    }),
    importPet: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pets:import",
      tag: WS_METHODS.petsImport,
    }),
    createPicture: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pets:create-picture",
      tag: WS_METHODS.petsCreatePicture,
    }),
    rename: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pets:rename",
      tag: WS_METHODS.petsRename,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pets:remove",
      tag: WS_METHODS.petsRemove,
    }),
    hatch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pets:hatch",
      tag: WS_METHODS.petsHatch,
    }),
  };
}
