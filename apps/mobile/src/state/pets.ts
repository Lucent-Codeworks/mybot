import { createPetEnvironmentAtoms } from "@mybot/client-runtime/state/pets";

import { connectionAtomRuntime } from "../connection/runtime";

export const petEnvironment = createPetEnvironmentAtoms(connectionAtomRuntime);
