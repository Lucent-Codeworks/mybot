import type { ProjectIconColor } from "@mybot/contracts";

/** Marketplace sections, in the order the category list shows them. */
export const BOT_TEMPLATE_CATEGORIES = [
  "Productivity",
  "Communication",
  "Writing & Content",
  "Research & Learning",
  "Education",
  "Engineering",
  "Data & Analytics",
  "Sales & Marketing",
  "Customer Support",
  "Business & Operations",
  "Money",
  "Health & Fitness",
  "Home & Family",
  "Travel & Lifestyle",
  "Shopping",
  "Creative & Hobbies",
  "Career",
  "Industries",
] as const;

export type BotTemplateCategory = (typeof BOT_TEMPLATE_CATEGORIES)[number];

export interface BotTemplateSkill {
  /** Folder name under the skills folder; lowercase words joined by dashes. */
  readonly name: string;
  /** The SKILL.md contents. */
  readonly content: string;
}

export interface BotTemplate {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly category: BotTemplateCategory;
  /** One line for the marketplace card. */
  readonly summary: string;
  /** Extra search words that are not already in the name, role, or summary. */
  readonly keywords?: ReadonlyArray<string>;
  /** Shown in the marketplace's Popular section. */
  readonly popular?: boolean;
  readonly icon: { readonly name: string; readonly color: ProjectIconColor };
  readonly instructions: string;
  readonly skills: ReadonlyArray<BotTemplateSkill>;
}

export const skill = (name: string, description: string, body: string): BotTemplateSkill => ({
  name,
  content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`,
});
