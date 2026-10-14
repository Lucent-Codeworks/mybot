import { claudeBackgroundWakeResultLabel } from "../../../Adapters/ClaudeAdapterV2.testkit.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT = [
  "Live-test a background subagent that keeps working after your turn ends. Do exactly this, with no extra steps.",
  "",
  "1) Use the Agent tool with run_in_background set to true to launch ONE general-purpose subagent with this prompt:",
  '   "Do 2 steps. Before each step, write exactly one line: SUB_STEP_N (N = 1, then 2). Then run this exact command with the Bash tool: sleep 3 && echo SUB_DONE_N. After both steps, reply with exactly: SUB_FINAL_REPORT"',
  "2) Immediately after launching it, reply with exactly ROOT_STARTED and stop. Do not wait for it or check on it.",
  "3) When its completion is reported, reply with exactly ROOT_WAKE_DONE and stop.",
].join("\n");

// Labels of the subagent's first frame after the root's result and of its
// completion notification in the transcript.
const SUBAGENT_FIRST_FRAME_LABEL = "assistant:background-subagent-after-root";
const SUBAGENT_NOTIFICATION_LABEL = "task_notification:background-subagent";

/** `lastSubagentText` is the subagent's last narration before its notification. */
export function claudeBackgroundSubagentAfterRootInput(
  lastSubagentText = "SUB_FINAL_REPORT",
): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT },
      // The subagent's frames all arrive after the root settles, and are
      // stored as they arrive. Its completion notification is held until
      // they are, so its continuation run 2 cannot race their ingestion.
      // Run 2 drains the wake reply, and the wake result is held until it
      // has, so the recording cannot end the session first.
      { type: "await_run_status", targetRunIndex: 1, status: "completed" },
      { type: "release_replay_gate", label: SUBAGENT_FIRST_FRAME_LABEL },
      {
        type: "await_threads",
        label: `subagent text ${lastSubagentText} stored`,
        until: (threads) =>
          threads.some((thread) =>
            thread.turnItems.some(
              (item) => item.type === "assistant_message" && item.text.trim() === lastSubagentText,
            ),
          ),
      },
      { type: "release_replay_gate", label: SUBAGENT_NOTIFICATION_LABEL },
      {
        type: "await_run_status",
        targetRunIndex: 2,
        status: "running",
        waitForTurnItemType: "assistant_message",
      },
      { type: "release_replay_gate", label: claudeBackgroundWakeResultLabel(1) },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}
