import { describe, expect, it } from "vite-plus/test";

import {
  classifyTelegramMessage,
  formatQuestion,
  parseApprovalReply,
  parseQuestionReply,
  splitTelegramText,
} from "./telegramLogic.ts";

describe("classifyTelegramMessage", () => {
  const unpaired = { ownerUserId: null, pairingCode: "K7Q2XD", fromUserId: 42 };
  const paired = { ownerUserId: 42, pairingCode: "K7Q2XD" };

  it("pairs only with the exact pairing code", () => {
    expect(classifyTelegramMessage({ ...unpaired, text: "/start K7Q2XD" })).toEqual({
      type: "pair",
    });
    expect(classifyTelegramMessage({ ...unpaired, text: "/start" })).toEqual({ type: "reject" });
    expect(classifyTelegramMessage({ ...unpaired, text: "hello" })).toEqual({ type: "reject" });
  });

  it("refuses everyone but the paired account", () => {
    expect(classifyTelegramMessage({ ...paired, fromUserId: 7, text: "hi" })).toEqual({
      type: "reject",
    });
    expect(classifyTelegramMessage({ ...paired, fromUserId: 7, text: "/start K7Q2XD" })).toEqual({
      type: "reject",
    });
  });

  it("delivers the owner's messages and understands its commands", () => {
    expect(classifyTelegramMessage({ ...paired, fromUserId: 42, text: " Plan my day " })).toEqual({
      type: "deliver",
      text: "Plan my day",
    });
    expect(classifyTelegramMessage({ ...paired, fromUserId: 42, text: "/new" })).toEqual({
      type: "new-conversation",
    });
    expect(classifyTelegramMessage({ ...paired, fromUserId: 42, text: "/start" })).toEqual({
      type: "greet",
    });
  });
});

describe("splitTelegramText", () => {
  it("keeps short replies whole", () => {
    expect(splitTelegramText("  Done.  ")).toEqual(["Done."]);
  });

  it("splits long replies at line breaks under the Telegram limit", () => {
    const paragraph = "word ".repeat(500).trim();
    const chunks = splitTelegramText([paragraph, paragraph, paragraph].join("\n\n"));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks.join(" ").replaceAll(/\s+/g, " ")).toBe(
      [paragraph, paragraph, paragraph].join(" "),
    );
  });
});

describe("approvals and questions in a chat", () => {
  it("reads yes, always, and no, and nothing else", () => {
    expect(parseApprovalReply(" Yes ")).toBe("accept");
    expect(parseApprovalReply("always")).toBe("acceptForSession");
    expect(parseApprovalReply("no")).toBe("decline");
    expect(parseApprovalReply("maybe later")).toBeNull();
  });

  const pick = {
    question: "Which calendar?",
    options: [{ label: "Work", value: "work" }, { label: "Personal" }],
  };

  it("numbers the options and maps a number to the option's value", () => {
    expect(formatQuestion(pick)).toContain("1. Work\n2. Personal");
    expect(parseQuestionReply(pick, "1")).toBe("work");
    expect(parseQuestionReply(pick, "2")).toBe("Personal");
    expect(parseQuestionReply(pick, "3")).toBeNull();
    expect(parseQuestionReply(pick, "1, 2")).toBeNull();
  });

  it("takes custom answers unless the question forbids them, and several picks when allowed", () => {
    expect(parseQuestionReply(pick, "The shared one")).toBe("The shared one");
    expect(parseQuestionReply({ ...pick, allowCustomAnswer: false }, "The shared one")).toBeNull();
    expect(parseQuestionReply({ ...pick, multiSelect: true }, "2, 1, 2")).toEqual([
      "Personal",
      "work",
    ]);
  });
});
