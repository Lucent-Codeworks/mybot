/**
 * Teach a task: while the user controls a bot's tab, the page reports what they
 * do in terms of the elements they touch, so the bot can turn the steps into a
 * skill. Nothing is recorded while an agent drives the tab.
 */

/** The page binding the recorder reports through. */
export const TEACH_BINDING = "__mybotTeachStep";

/** The most steps one lesson keeps; a demonstration longer than this is truncated. */
export const MAX_TEACH_STEPS = 300;

/**
 * Installed in every frame of a teaching tab. Secrets (passwords, one-time
 * codes, card security codes) are reported without their value.
 */
export const TEACH_RECORDER_SCRIPT = `(() => {
  if (window.__mybotTeachInstalled || typeof window.${TEACH_BINDING} !== "function") return;
  window.__mybotTeachInstalled = true;
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "dropdown";
    if (tag === "textarea") return "field";
    if (tag === "input") {
      if (el.type === "checkbox") return "checkbox";
      if (el.type === "radio") return "radio button";
      if (el.type === "submit" || el.type === "button") return "button";
      return "field";
    }
    return tag;
  };
  const describe = (node) => {
    if (!(node instanceof Element)) return "the page";
    const el = node.closest("a,button,input,select,textarea,summary,label,[role]") || node;
    const label = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    const name = (
      el.getAttribute("aria-label") ||
      (label && label.textContent) ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      (el.tagName === "INPUT" && (el.type === "submit" || el.type === "button") ? el.value : "") ||
      el.textContent ||
      el.getAttribute("name") ||
      ""
    ).replace(/\\s+/g, " ").trim().slice(0, 80);
    const role = roleOf(el);
    return name ? role + ' "' + name + '"' : role;
  };
  const isSecret = (el) =>
    el instanceof HTMLInputElement &&
    (el.type === "password" ||
      /one-time-code|cc-csc|otp|passcode|verification/i.test(
        (el.autocomplete || "") + " " + (el.name || "") + " " + (el.id || ""),
      ));
  const send = (step) => {
    try {
      window.${TEACH_BINDING}(step);
    } catch {}
  };
  document.addEventListener("click", (event) => send({ kind: "click", target: describe(event.target) }), true);
  document.addEventListener(
    "change",
    (event) => {
      const el = event.target;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
      const value =
        el instanceof HTMLSelectElement
          ? (el.selectedOptions[0] && el.selectedOptions[0].textContent) || el.value
          : el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")
            ? (el.checked ? "checked" : "unchecked")
            : el.value;
      send({ kind: "input", target: describe(el), value: isSecret(el) ? null : String(value).slice(0, 200) });
    },
    true,
  );
  // A form is named by its label, never by all the text inside it.
  const formName = (form) => {
    const name = form instanceof Element && (form.getAttribute("aria-label") || form.getAttribute("name"));
    return name ? 'form "' + name.trim().slice(0, 80) + '"' : "the form";
  };
  document.addEventListener("submit", (event) => send({ kind: "submit", target: formName(event.target) }), true);
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter") send({ kind: "key", key: "Enter", target: describe(event.target) });
    },
    true,
  );
})()`;

/** One step as the recorder reports it; anything else is ignored. */
export function formatTeachStep(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const step = raw as Record<string, unknown>;
  const target = typeof step.target === "string" ? step.target.slice(0, 120) : "the page";
  switch (step.kind) {
    case "click":
      return `Clicked ${target}`;
    case "input":
      return typeof step.value === "string"
        ? `Set ${target} to "${step.value}"`
        : `Entered a secret into ${target} (the user does this step)`;
    case "submit":
      return `Submitted ${target}`;
    case "key":
      return `Pressed Enter in ${target}`;
    default:
      return null;
  }
}

/** Adds a step to a lesson, skipping an immediate repeat and keeping it bounded. */
export function addTeachStep(steps: Array<string>, step: string): void {
  if (steps.length >= MAX_TEACH_STEPS || steps.at(-1) === step) return;
  steps.push(step);
}
