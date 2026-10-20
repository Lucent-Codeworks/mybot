import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputControllerDependencies,
  type VoiceTranscriber,
} from "@mybot/client-runtime/voice-input";
import type { EnvironmentId } from "@mybot/contracts";

export type VoiceInputTarget = {
  readonly ownerKey: string;
  /** The MyBot server that transcribes on Android; null when the draft has none. */
  readonly environmentId: EnvironmentId | null;
  /** Names the draft being dictated into while its composer is off screen. */
  readonly label?: string;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: VoiceInputControllerDependencies["commitDraft"];
  readonly subscribe: () => () => void;
  /** Sends the draft through its screen's normal send path, after `stop("send")` inserts. */
  readonly submit?: () => void;
};

export function createVoiceInputTarget(
  ownerKey: string,
  readText: () => string | null,
  commitDraft: VoiceInputTarget["commitDraft"],
  selection: VoiceDraftSnapshot["selection"],
  subscribeToChanges: (onChange: () => void) => () => void,
): VoiceInputTarget {
  let revision = 0;
  return {
    ownerKey,
    environmentId: null,
    readDraft: () => {
      const text = readText();
      if (text === null) return null;
      return { ownerKey, text, selection, revision };
    },
    commitDraft,
    subscribe: () => {
      let previousText = readText();
      return subscribeToChanges(() => {
        const text = readText();
        if (text !== previousText) {
          previousText = text;
          revision += 1;
        }
      });
    },
  };
}

export class VoiceInputSession {
  readonly controller: VoiceInputController;
  private target: VoiceInputTarget | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    dependencies: Omit<
      VoiceInputControllerDependencies,
      "readDraft" | "commitDraft" | "submitDraft" | "getTranscriber"
    > & {
      readonly getTranscriber: (target: VoiceInputTarget) => VoiceTranscriber | null;
    },
  ) {
    this.controller = new VoiceInputController({
      ...dependencies,
      getTranscriber: () => (this.target ? dependencies.getTranscriber(this.target) : null),
      onStateChange: (state) => {
        // A kept recording is checked against its draft on retry, so keep watching edits.
        if (!voiceInputBlocksSubmission(state) && state.errorAction !== "retry-transcription") {
          this.unsubscribe?.();
          this.unsubscribe = null;
        }
        dependencies.onStateChange(state);
      },
      readDraft: () => this.target?.readDraft() ?? null,
      commitDraft: (text, selection) => this.target?.commitDraft(text, selection),
      submitDraft: () => this.target?.submit?.(),
    });
  }

  get ownerKey(): string | null {
    return this.target?.ownerKey ?? null;
  }

  get label(): string | null {
    return this.target?.label ?? null;
  }

  cancel(ownerKey: string | null): void {
    if (ownerKey !== null && this.ownerKey === ownerKey) this.controller.cancel();
  }

  /** A failed transcription kept its recording for `retry()`, or `cancel` to discard it. */
  get keepsRecording(): boolean {
    return this.controller.currentState.errorAction === "retry-transcription";
  }

  /** Whether `stop("send")` can send the current draft. */
  get canSubmit(): boolean {
    return this.target?.submit !== undefined;
  }

  /** Sends a recording kept after a failed transcription again, or records anew. */
  retry(): Promise<void> {
    if (this.keepsRecording) {
      return this.controller.retryTranscription();
    }
    return this.target ? this.start(this.target) : Promise.resolve();
  }

  start(target: VoiceInputTarget): Promise<void> {
    if (voiceInputBlocksSubmission(this.controller.currentState)) return Promise.resolve();
    this.unsubscribe?.();
    this.target = target;
    this.unsubscribe = target.subscribe();
    return this.controller.start();
  }
}
