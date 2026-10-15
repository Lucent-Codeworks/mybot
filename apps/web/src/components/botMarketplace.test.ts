import { BOT_TEMPLATES } from "@t3tools/shared/botTemplates";
import { iconNames } from "lucide-react/dynamic";
import { describe, expect, it } from "vite-plus/test";

describe("bot marketplace icons", () => {
  it("names a Lucide icon for every template", () => {
    for (const template of BOT_TEMPLATES) {
      expect(iconNames, template.id).toContain(template.icon.name);
    }
  });
});
