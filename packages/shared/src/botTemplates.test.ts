import { describe, expect, it } from "vite-plus/test";

import { BOT_TEMPLATES, findBotTemplate } from "./botTemplates.ts";

describe("the bot marketplace", () => {
  it("has unique templates whose skills are well-formed and uniquely named", () => {
    const ids = BOT_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    const skillNames = BOT_TEMPLATES.flatMap((template) => template.skills.map((s) => s.name));
    expect(new Set(skillNames).size).toBe(skillNames.length);
    for (const template of BOT_TEMPLATES) {
      expect(template.instructions.trim().length, template.id).toBeGreaterThan(0);
      expect(template.role.length, template.id).toBeLessThanOrEqual(120);
      for (const skill of template.skills) {
        expect(skill.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(skill.content.startsWith(`---\nname: ${skill.name}\n`)).toBe(true);
      }
    }
    expect(findBotTemplate("research-analyst")?.name).toBe("Analyst");
    expect(findBotTemplate("missing")).toBeUndefined();
  });
});
