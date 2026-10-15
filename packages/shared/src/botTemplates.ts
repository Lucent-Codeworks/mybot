/**
 * The bot marketplace: ready-made bots a user can add in one step. A template
 * fills the New bot dialog (name, job, instructions, icon); its skills are
 * written to the shared skills folder when the bot is created, unless a skill
 * with that name already exists.
 */
import { BUSINESS_TEMPLATES } from "./botTemplates/business.ts";
import { KNOWLEDGE_TEMPLATES } from "./botTemplates/knowledge.ts";
import { LIFESTYLE_TEMPLATES } from "./botTemplates/lifestyle.ts";
import {
  BOT_TEMPLATE_CATEGORIES,
  type BotTemplate,
  type BotTemplateCategory,
  type BotTemplateSkill,
} from "./botTemplates/model.ts";
import { ORIGINAL_TEMPLATES } from "./botTemplates/originals.ts";
import { PERSONAL_TEMPLATES } from "./botTemplates/personal.ts";
import { PRODUCTIVITY_TEMPLATES } from "./botTemplates/productivity.ts";
import { TECH_TEMPLATES } from "./botTemplates/tech.ts";

export { BOT_TEMPLATE_CATEGORIES };
export type { BotTemplate, BotTemplateCategory, BotTemplateSkill };

export const BOT_TEMPLATES: ReadonlyArray<BotTemplate> = [
  ...ORIGINAL_TEMPLATES,
  ...PRODUCTIVITY_TEMPLATES,
  ...KNOWLEDGE_TEMPLATES,
  ...TECH_TEMPLATES,
  ...BUSINESS_TEMPLATES,
  ...PERSONAL_TEMPLATES,
  ...LIFESTYLE_TEMPLATES,
];

export function findBotTemplate(id: string): BotTemplate | undefined {
  return BOT_TEMPLATES.find((template) => template.id === id);
}
