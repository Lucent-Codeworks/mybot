import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  serverVoiceAvailability,
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@mybot/client-runtime/voice-input";
import type { EnvironmentId } from "@mybot/contracts";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useVoiceInputStatus } from "../../state/voice-input";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { promptVoiceInputSetup } from "./voiceInputSetup";
import { createVoiceInputTarget } from "./voiceInputSession";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  /** The MyBot server that transcribes on Android. */
  readonly environmentId: EnvironmentId | null;
  /** Shown by the global dictation pill when this composer is off screen. */
  readonly label: string;
  readonly readDraftMessage: () => string | null;
  readonly subscribeToDraftChanges: (onChange: () => void) => () => void;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
  /** The screen's normal send path. Without it dictation only inserts. */
  readonly onSubmit?: () => void;
}) {
  const global = useGlobalVoiceInput();
  const { setOwnerFocused, session } = global;
  const latestInput = useRef(input);
  latestInput.current = input;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const ownerKey = input.ownerKey;
      if (!ownerKey) return;
      setOwnerFocused(ownerKey, true);
      return () => setOwnerFocused(ownerKey, false);
    }, [input.ownerKey, setOwnerFocused]),
  );

  // Android servers advertise voice input and may still need a speech model.
  const config = useEnvironmentServerConfig(
    global.transcribesOnServer ? input.environmentId : null,
  );
  const capability = config?.environment.capabilities.voiceInput;
  const status = useVoiceInputStatus(capability === true ? input.environmentId : null);
  const serverAvailability = global.transcribesOnServer
    ? serverVoiceAvailability({ capability, status })
    : "ready";
  const serverAvailabilityRef = useRef(serverAvailability);
  serverAvailabilityRef.current = serverAvailability;

  // Sends after React renders the inserted transcript, so the send path reads it.
  const [sendRequest, setSendRequest] = useState(0);
  useEffect(() => {
    if (sendRequest > 0) latestInput.current.onSubmit?.();
  }, [sendRequest]);

  const start = useCallback(() => {
    const captured = latestInput.current;
    if (!captured.ownerKey || captured.disabled) return;
    if (session.ownerKey === captured.ownerKey && session.keepsRecording) {
      void session.retry();
      return;
    }
    if (serverAvailabilityRef.current === "needs-setup" && captured.environmentId !== null) {
      promptVoiceInputSetup(captured.environmentId);
      return;
    }
    void session.start({
      ...createVoiceInputTarget(
        captured.ownerKey,
        captured.readDraftMessage,
        (text, selection) => {
          captured.onChangeDraftMessage(text);
          if (mounted.current && latestInput.current.ownerKey === captured.ownerKey) {
            latestInput.current.onChangeSelection(selection);
          }
        },
        captured.selection,
        captured.subscribeToDraftChanges,
      ),
      label: captured.label,
      environmentId: captured.environmentId,
      ...(captured.onSubmit
        ? {
            submit: () => {
              if (mounted.current && latestInput.current.ownerKey === captured.ownerKey) {
                setSendRequest((count) => count + 1);
              }
            },
          }
        : {}),
    });
  }, [session]);
  const state = global.ownerKey === input.ownerKey ? global.state : IDLE_STATE;
  const isBusy = voiceInputBlocksSubmission(state);
  return {
    isAvailable:
      global.isAvailable &&
      (serverAvailability === "ready" || serverAvailability === "needs-setup") &&
      (!global.isBusy || global.ownerKey === input.ownerKey),
    state,
    audioLevels: global.audioLevels,
    elapsedSeconds: global.elapsedSeconds,
    isBusy,
    freezesEditor: isBusy,
    blocksSubmission: isBusy,
    start,
    stop: global.stop,
    /** Inserts the transcript and sends the draft; undefined when the screen has no send. */
    send: input.onSubmit ? global.send : undefined,
    cancel: global.cancel,
  };
}
