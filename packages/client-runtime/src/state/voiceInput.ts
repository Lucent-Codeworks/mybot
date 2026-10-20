import {
  WS_METHODS,
  type EnvironmentId,
  type VoiceCreateUploadUrlInput,
  type VoiceCreateUploadUrlResult,
  type VoiceTranscribeInput,
  type VoiceTranscribeResult,
  type VoiceTranscriptionCancelInput,
} from "@mybot/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { ServerTranscriberDependencies } from "../voice-input/serverTranscriber.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "./runtime.ts";

/**
 * Voice model status and transcription RPCs for one client's connection
 * runtime. Install, cancel-install, and remove are guarded: read each
 * command's `permissionAtom(environmentId)` for UI availability.
 */
export function createVoiceInputEnvironment<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:voice:status",
      tag: WS_METHODS.voiceStatusSubscribe,
      idleTtlMs: 0,
    }),
    install: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice:install",
      tag: WS_METHODS.voiceInstall,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    cancelInstall: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice:install-cancel",
      tag: WS_METHODS.voiceInstallCancel,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice:remove",
      tag: WS_METHODS.voiceRemove,
    }),
    createUploadUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice:create-upload-url",
      tag: WS_METHODS.voiceCreateUploadUrl,
    }),
    transcribe: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice:transcribe",
      tag: WS_METHODS.voiceTranscribe,
    }),
    cancelTranscription: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:voice:transcription-cancel",
      tag: WS_METHODS.voiceTranscriptionCancel,
    }),
  };
}

type EnvironmentCommand<I, A> = AtomCommand<
  { readonly environmentId: EnvironmentId; readonly input: I },
  A,
  unknown
>;

async function runOrThrow<I, A>(
  registry: AtomRegistry.AtomRegistry,
  command: EnvironmentCommand<I, A>,
  environmentId: EnvironmentId,
  input: I,
): Promise<A> {
  const result = await runAtomCommand(
    registry,
    command,
    { environmentId, input },
    { reportFailure: false },
  );
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  return result.value;
}

/**
 * The RPC half of {@link ServerTranscriberDependencies} for one environment.
 * Failures reject with the squashed server error, which the transcriber maps.
 */
export function voiceTranscriptionRpc(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly environmentId: EnvironmentId;
  readonly voice: {
    readonly createUploadUrl: EnvironmentCommand<
      VoiceCreateUploadUrlInput,
      VoiceCreateUploadUrlResult
    >;
    readonly transcribe: EnvironmentCommand<VoiceTranscribeInput, VoiceTranscribeResult>;
    readonly cancelTranscription: EnvironmentCommand<VoiceTranscriptionCancelInput, unknown>;
  };
}): Pick<ServerTranscriberDependencies, "createUploadUrl" | "transcribe" | "cancel"> {
  const { registry, environmentId, voice } = input;
  return {
    createUploadUrl: (sizeBytes) =>
      runOrThrow(registry, voice.createUploadUrl, environmentId, { sizeBytes }),
    transcribe: async (uploadId) =>
      (await runOrThrow(registry, voice.transcribe, environmentId, { uploadId })).text,
    cancel: async (uploadId) => {
      await runOrThrow(registry, voice.cancelTranscription, environmentId, { uploadId });
    },
  };
}
