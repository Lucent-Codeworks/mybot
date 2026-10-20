import { resolveAssetUrl } from "@mybot/client-runtime/state/assets";
import { voiceTranscriptionRpc } from "@mybot/client-runtime/state/voice-input";
import {
  VoiceInputController,
  createServerVoiceTranscriber,
  voiceInputFreezesEditor,
  type VoiceInputOutcome,
  type VoiceInputState,
  type VoiceTranscriber,
} from "@mybot/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@mybot/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { toastManager } from "../../components/ui/toast";
import { isElectron } from "../../env";
import { isMacPlatform } from "../../lib/utils";
import { resolveShortcutCommand, type ShortcutMatchContext } from "../../keybindings";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useServerConfigs } from "../../state/entities";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import { useVoiceInputStatus, voiceInputEnvironment } from "../../state/voiceInput";
import { createWindowVoiceRecorder } from "./browserVoiceRecorder";
import { decodeToWav } from "./decodeToWav";
import { classifyRecordingKeyTarget, recordingKeyOutcome } from "./recordingKeys";
import {
  INSECURE_VOICE_MESSAGE,
  webVoiceAvailability,
  type WebVoiceAvailability,
} from "./voiceInputAvailability";
import { requestVoiceInputSetup } from "./voiceInputSetup";

const VOICE_TOGGLE_EVENT = "mybot:composer-voice-toggle";

/** Starts voice input in the open composer, or stops it and inserts the transcript. */
export function requestComposerVoiceToggle(): void {
  window.dispatchEvent(new Event(VOICE_TOGGLE_EVENT));
}

function microphoneSettingsHint(): string {
  if (!isElectron) return "Allow microphone access for this site in your browser settings.";
  return isMacPlatform(navigator.platform)
    ? "Allow MyBot to use the microphone in System Settings → Privacy & Security → Microphone."
    : "Allow MyBot to use the microphone in your system privacy settings.";
}

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

function createComposerTranscriber(environmentId: EnvironmentId): VoiceTranscriber | null {
  if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return null;
  return createServerVoiceTranscriber({
    locale: () => navigator.language,
    readWav: async (uri, signal) => {
      const response = await fetch(uri, { signal });
      return decodeToWav(await response.blob(), signal);
    },
    resolveUrl: (relativeUrl) => {
      if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return null;
      const connection = readPreparedConnection(environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    post: async (url, body, signal) => {
      const response = await fetch(url, {
        method: "POST",
        body: new Blob([body.slice()], { type: "audio/wav" }),
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

export interface ComposerVoiceInputOptions {
  /** The server that transcribes; bound when a recording starts. */
  readonly environmentId: EnvironmentId;
  /** Names the draft. A different key cancels voice input in progress. */
  readonly ownerKey: string;
  /** False hides voice input, as when this device cannot operate the thread. */
  readonly enabled: boolean;
  /** The draft text as rendered; each change makes an in-flight transcript stale. */
  readonly draftText: string;
  readonly readDraft: () => {
    readonly text: string;
    readonly selection: { readonly start: number; readonly end: number };
  } | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
  /** The composer's normal send path, the same one the Send button uses. */
  readonly submit: () => void;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly shortcutContext: () => Partial<ShortcutMatchContext>;
  /** The composer's root, so Esc and Enter only act on keys meant for it. */
  readonly composerElement: () => Element | null;
}

export interface ComposerVoiceInput {
  readonly availability: WebVoiceAvailability;
  readonly state: VoiceInputState;
  /** `Date.now()` when the current recording started, null when not recording. */
  readonly recordingStartedAt: number | null;
  /** The editor is read-only while voice input can still write the draft. */
  readonly freezesEditor: boolean;
  readonly toggle: () => void;
  /** Sends a recording kept after a failed transcription again. */
  readonly retryTranscription: () => void;
  readonly stop: (outcome: VoiceInputOutcome) => void;
  readonly cancel: () => void;
  /**
   * Called by the composer's submit. While recording it stops and sends, and
   * while preparing or transcribing it holds the send. True when it handled it.
   */
  readonly interceptSubmit: () => boolean;
}

/** Records in the browser and transcribes on the composer's MyBot server. */
export function useComposerVoiceInput(options: ComposerVoiceInputOptions): ComposerVoiceInput {
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });
  const revisionRef = useRef(0);
  const [state, setState] = useState<VoiceInputState>(IDLE_STATE);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [sendRequest, setSendRequest] = useState(0);

  const capability = useServerConfigs().get(options.environmentId)?.environment.capabilities
    .voiceInput;
  const status = useVoiceInputStatus(capability === true ? options.environmentId : null);
  const availability = webVoiceAvailability({
    capability: options.enabled && capability,
    secureContext: window.isSecureContext,
    hasMediaRecorder: typeof MediaRecorder !== "undefined",
    status,
  });
  const availabilityRef = useRef(availability);
  useLayoutEffect(() => {
    availabilityRef.current = availability;
  }, [availability]);

  const [controller] = useState(() => {
    const recorder = createWindowVoiceRecorder((recorderStatus) => {
      void created.handleRecorderStatus(recorderStatus);
    });
    const created: VoiceInputController = new VoiceInputController({
      recorder,
      getTranscriber: () => createComposerTranscriber(optionsRef.current.environmentId),
      requestPermission: async () => {
        // The desktop app asks macOS first; a denial there can only be fixed in System Settings.
        const requestAppAccess = window.desktopBridge?.requestMicrophoneAccess;
        if (requestAppAccess && !(await requestAppAccess())) {
          return { granted: false, canAskAgain: false };
        }
        return recorder.requestPermission();
      },
      configureRecording: async () => {},
      releaseRecording: async () => recorder.release(),
      deleteRecording: (uri) => recorder.deleteRecording(uri),
      readDraft: () => {
        const draft = optionsRef.current.readDraft();
        if (!draft) return null;
        return { ownerKey: optionsRef.current.ownerKey, ...draft, revision: revisionRef.current };
      },
      commitDraft: (text, selection) => optionsRef.current.commitDraft(text, selection),
      // Sends after React renders the committed draft, so the send reads it.
      submitDraft: () => setSendRequest((count) => count + 1),
      onStateChange: (next) => {
        // Whatever ended the session, the microphone indicator goes off with it.
        if (next.phase === "idle" || next.phase === "error") recorder.release();
        setRecordingStartedAt((startedAt) =>
          next.phase === "recording" ? (startedAt ?? Date.now()) : null,
        );
        // A kept recording shows its error inline with Retry and Discard.
        if (next.phase === "error" && next.error && next.errorAction !== "retry-transcription") {
          toastManager.add({
            type: "error",
            title: next.error,
            ...(next.errorAction === "settings"
              ? {
                  description: microphoneSettingsHint(),
                }
              : {}),
          });
        }
        setState(next);
      },
    });
    return created;
  });

  // Any edit to the draft, even one undone later, makes an in-flight transcript stale.
  useEffect(() => {
    revisionRef.current += 1;
  }, [options.draftText]);

  const ownerKeyRef = useRef(options.ownerKey);
  useEffect(() => {
    if (ownerKeyRef.current === options.ownerKey) return;
    ownerKeyRef.current = options.ownerKey;
    controller.ownerChanged();
  }, [controller, options.ownerKey]);

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    if (sendRequest === 0) return;
    optionsRef.current.submit();
  }, [sendRequest]);

  const [actions] = useState(() => {
    const toggle = () => {
      const current = availabilityRef.current;
      if (current === "needs-setup") {
        requestVoiceInputSetup(optionsRef.current.environmentId);
        return;
      }
      if (current === "insecure") {
        toastManager.add({ type: "info", title: INSECURE_VOICE_MESSAGE });
        return;
      }
      if (current !== "ready") return;
      const phase = controller.currentState.phase;
      if (phase === "recording") void controller.stop("insert");
      else if (phase === "idle" || phase === "error") void controller.start();
    };
    return {
      toggle,
      stop: (outcome: VoiceInputOutcome) => void controller.stop(outcome),
      cancel: () => controller.cancel(),
      retryTranscription: () => void controller.retryTranscription(),
      interceptSubmit: () => {
        const phase = controller.currentState.phase;
        if (phase === "recording") {
          void controller.stop("send");
          return true;
        }
        return phase === "preparing" || phase === "transcribing";
      },
    };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const recording = controller.currentState.phase === "recording";
      const command = resolveShortcutCommand(event, optionsRef.current.keybindings, {
        context: optionsRef.current.shortcutContext(),
      });
      if (command === "composer.voice") {
        const current = availabilityRef.current;
        if (current === "hidden" || current === "unsupported") return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && !isCommandPaletteOpen()) actions.toggle();
        return;
      }
      if (!recording) return;
      const outcome = recordingKeyOutcome({
        key: event.key,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isComposing: event.isComposing,
        terminalFocus: optionsRef.current.shortcutContext().terminalFocus === true,
        target: classifyRecordingKeyTarget(event.target, optionsRef.current.composerElement()),
      });
      if (outcome === null) return;
      event.preventDefault();
      event.stopPropagation();
      void controller.stop(outcome);
    };
    const onToggleRequest = () => actions.toggle();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener(VOICE_TOGGLE_EVENT, onToggleRequest);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener(VOICE_TOGGLE_EVENT, onToggleRequest);
    };
  }, [actions, controller]);

  return {
    availability,
    state,
    recordingStartedAt,
    freezesEditor: voiceInputFreezesEditor(state),
    ...actions,
  };
}
