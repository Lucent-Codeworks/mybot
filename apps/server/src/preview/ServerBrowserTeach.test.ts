// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";

import {
  addTeachStep,
  formatTeachStep,
  MAX_TEACH_STEPS,
  TEACH_BINDING,
  TEACH_RECORDER_SCRIPT,
} from "./ServerBrowserTeach.ts";

// The server compiles without DOM types; jsdom provides these at run time.
interface TestElement {
  value: string;
  selectedIndex: number;
  dispatchEvent(event: unknown): boolean;
}
declare const window: { eval(code: string): unknown } & Record<string, unknown>;
declare const document: {
  body: { innerHTML: string };
  querySelector(selector: string): TestElement | null;
};
declare const Event: new (type: string, init?: { bubbles?: boolean }) => unknown;
declare const MouseEvent: new (type: string, init?: { bubbles?: boolean }) => unknown;

describe("the teach recorder", () => {
  it("reports what the user touches by label, and never a secret's value", () => {
    const steps: Array<string> = [];
    window[TEACH_BINDING] = (raw: unknown) => {
      const step = formatTeachStep(raw);
      if (step) steps.push(step);
    };
    // Chromium has CSS.escape; jsdom does not.
    (globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value };
    document.body.innerHTML = `
      <form>
        <label for="amount">Amount</label><input id="amount" />
        <input type="password" aria-label="Password" />
        <select aria-label="Category"><option>Travel</option><option>Meals</option></select>
        <button type="submit">Submit expense</button>
      </form>`;
    window.eval(TEACH_RECORDER_SCRIPT);
    // Installing twice must not double every step.
    window.eval(TEACH_RECORDER_SCRIPT);

    const amount = document.querySelector("#amount")!;
    amount.value = "42.50";
    amount.dispatchEvent(new Event("change", { bubbles: true }));
    const password = document.querySelector('input[type="password"]')!;
    password.value = "hunter2";
    password.dispatchEvent(new Event("change", { bubbles: true }));
    const category = document.querySelector("select")!;
    category.selectedIndex = 1;
    category.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(steps).toEqual([
      'Set field "Amount" to "42.50"',
      'Entered a secret into field "Password" (the user does this step)',
      'Set dropdown "Category" to "Meals"',
      'Clicked button "Submit expense"',
      "Submitted the form",
    ]);
    expect(steps.join("\n")).not.toContain("hunter2");
  });
});

describe("lesson steps", () => {
  it("ignores unknown reports, skips immediate repeats, and stays bounded", () => {
    expect(formatTeachStep({ kind: "scroll" })).toBeNull();
    expect(formatTeachStep("click")).toBeNull();
    const steps: Array<string> = [];
    addTeachStep(steps, "Clicked link");
    addTeachStep(steps, "Clicked link");
    expect(steps).toEqual(["Clicked link"]);
    for (let index = 0; index < MAX_TEACH_STEPS + 10; index += 1)
      addTeachStep(steps, `Step ${index}`);
    expect(steps).toHaveLength(MAX_TEACH_STEPS);
  });
});
