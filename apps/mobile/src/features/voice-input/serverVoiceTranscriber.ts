import { resolveAssetUrl } from "@mybot/client-runtime/state/assets";
import { voiceTranscriptionRpc } from "@mybot/client-runtime/state/voice-input";
import {
  createServerVoiceTranscriber,
  serverVoiceAvailability,
  type ServerVoiceAvailability,
  type VoiceTranscriber,
} from "@mybot/client-runtime/voice-input";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@mybot/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { environmentSession, readEnvironmentScope } from "../../state/session";
import { voiceInputEnvironment } from "../../state/voice-input";

/** Whether `environmentId` can transcribe now, from its advertised capability and live status. */
export function readServerVoiceAvailability(environmentId: EnvironmentId): ServerVoiceAvailability {
  const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
  const status = appAtomRegistry.get(voiceInputEnvironment.status({ environmentId, input: {} }));
  return serverVoiceAvailability({
    capability: config?.environment.capabilities.voiceInput,
    status: Option.getOrNull(AsyncResult.value(status)),
  });
}

/**
 * Transcribes Android recordings on the draft's MyBot server: the WAV is
 * uploaded over HTTP like attachments, then transcribed by RPC. Null when this
 * device cannot operate that server.
 */
export function createMobileServerVoiceTranscriber(
  environmentId: EnvironmentId,
): VoiceTranscriber | null {
  const canOperate = () => readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  if (!canOperate()) return null;
  return createServerVoiceTranscriber({
    locale: () => Intl.DateTimeFormat().resolvedOptions().locale,
    readWav: async (uri) => {
      const { File } = await import("expo-file-system");
      return new Uint8Array(await new File(uri).arrayBuffer());
    },
    // Read the connection at upload time: the server may have reconnected on a new base URL.
    resolveUrl: (relativeUrl) => {
      if (!canOperate()) return null;
      const connection = appAtomRegistry.get(
        environmentSession.preparedConnectionValueAtom(environmentId),
      );
      return Option.isNone(connection)
        ? null
        : resolveAssetUrl(connection.value.httpBaseUrl, relativeUrl);
    },
    post: async (url, body, signal) => {
      const response = await fetch(url, {
        method: "POST",
        // React Native sends typed arrays as raw bytes; the copy narrows the buffer type for fetch.
        body: body.slice(),
        headers: { "Content-Type": "audio/wav" },
        signal,
      });
      if (!response.ok) throw new Error(`Upload failed (${response.status})`);
    },
    ...voiceTranscriptionRpc({
      registry: appAtomRegistry,
      environmentId,
      voice: voiceInputEnvironment,
    }),
  });
}
