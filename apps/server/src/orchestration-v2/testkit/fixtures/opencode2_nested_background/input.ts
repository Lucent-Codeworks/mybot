import { OPENCODE2_NESTED_BACKGROUND_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

/**
 * The thread's turn ends while a foreground subagent's own background
 * subagent still runs. The run completes while it is listed as background
 * work, and that grandchild's report then reaches the subagent that started it.
 */
export function openCode2NestedBackgroundInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_NESTED_BACKGROUND_PROMPT },
      // The grandchild's frames after the thread's turn wait for its run to
      // complete with the grandchild listed as background work.
      {
        type: "release_replay_gate_after_waiting",
        label: "session.step.started.5",
        targetRunIndex: 1,
      },
      // The middle subagent answers the report in a second turn of its own.
      {
        type: "await_threads",
        label: "middle subagent's second turn completed",
        until: (threads) =>
          threads.some(
            (thread) =>
              thread.providerTurns.filter((turn) => turn.status === "completed").length === 2,
          ),
      },
    ],
  };
}
