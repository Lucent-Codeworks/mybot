import { assert, describe, it } from "@effect/vitest";

import {
  MYBOT_ORCHESTRATION_INSTRUCTIONS,
  myBotAcpPromptWithInstructions,
  myBotOrchestrationPromptForFirstRun,
  myBotOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("MyBot orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(MYBOT_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(MYBOT_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level MyBot conversations");
    assert.include(MYBOT_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(MYBOT_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(MYBOT_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      MYBOT_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `t3_thread_send` on `childThreadId`",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(MYBOT_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(MYBOT_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(MYBOT_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = myBotOrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasMyBotMcp: true,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      myBotOrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasMyBotMcp: true }),
      prompt,
    );
    assert.equal(
      myBotOrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasMyBotMcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the MyBot MCP server is attached", () => {
    assert.equal(myBotOrchestrationSystemPrompt(false), undefined);
    assert.equal(myBotOrchestrationSystemPrompt(true), MYBOT_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = myBotAcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasMyBotMcp: true },
    });

    assert.include(injected, "MyBot interaction mode: Default");
    assert.include(injected, "MyBot collaborative browser");
    assert.include(injected, "MyBot orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasMyBotMcp: true } as const;

    assert.equal(
      myBotAcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      myBotAcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "MyBot interaction mode: Plan",
    );
    const withoutMcp = myBotAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasMyBotMcp: false },
    });
    assert.include(withoutMcp, "MyBot interaction mode: Default");
    assert.notInclude(withoutMcp, "MyBot collaborative browser");
    assert.notInclude(withoutMcp, "MyBot orchestration");
  });
});
