/**
 * The bot marketplace: ready-made bots a user can add in one step. A template
 * fills the New bot dialog (name, job, instructions, icon); its skills are
 * written to the shared skills folder when the bot is created, unless a skill
 * with that name already exists.
 */

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
  readonly category: "Productivity" | "Research" | "Work" | "Personal" | "Engineering";
  /** One line for the marketplace card. */
  readonly summary: string;
  readonly icon: { readonly name: string; readonly color: BotTemplateColor };
  readonly instructions: string;
  readonly skills: ReadonlyArray<BotTemplateSkill>;
}

type BotTemplateColor =
  | "amber"
  | "blue"
  | "emerald"
  | "indigo"
  | "orange"
  | "pink"
  | "sky"
  | "violet";

const skill = (name: string, description: string, body: string): BotTemplateSkill => ({
  name,
  content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`,
});

export const BOT_TEMPLATES: ReadonlyArray<BotTemplate> = [
  {
    id: "daily-briefing",
    name: "Briefing",
    role: "Morning briefing",
    category: "Productivity",
    summary: "Reads the sources you care about and sends a short briefing every morning.",
    icon: { name: "newspaper", color: "amber" },
    instructions: `Each morning, prepare a briefing of what changed in the topics and sources the user follows. Keep it to five bullets or fewer, newest and most important first, each with its source link.

If you do not know the user's topics yet, ask once and remember them. Offer to set up a weekday routine for the briefing.`,
    skills: [
      skill(
        "morning-briefing",
        "Collect overnight news on the user's topics and write a five-bullet briefing.",
        `## When to use
Every weekday morning, or when the user asks what they missed.

## Steps
1. Read the user's topics and sources from memory.
2. Search each topic for news since the last briefing; open the source pages in the browser when a summary is not enough.
3. Drop duplicates and anything older than the last briefing.
4. Write at most five bullets, most important first, each with one link.

## Check
Every bullet has a working link and a date within the period.`,
      ),
    ],
  },
  {
    id: "research-analyst",
    name: "Analyst",
    role: "Research analyst",
    category: "Research",
    summary: "Researches a question across the web and writes a sourced report.",
    icon: { name: "search", color: "blue" },
    instructions: `Answer research questions with a short report: the answer first, then the evidence, then open questions. Cite every claim with a link. Prefer primary sources and say when sources disagree.

Save finished reports as Markdown files in your folder, named by date and topic, and tell the user where.`,
    skills: [
      skill(
        "research-report",
        "Research a question across several sources and write a cited report.",
        `## Steps
1. Restate the question and what a good answer needs.
2. Search widely, then read the five best sources fully in the browser.
3. Write: answer, evidence with citations, disagreements, open questions.
4. Save the report as reports/<date>-<topic>.md.

## Check
Every factual sentence has a citation; the answer is in the first paragraph.`,
      ),
    ],
  },
  {
    id: "inbox-assistant",
    name: "Inbox",
    role: "Inbox triage",
    category: "Work",
    summary: "Sorts your email, summarizes what matters, and drafts replies for you to approve.",
    icon: { name: "inbox", color: "sky" },
    instructions: `Triage the user's email: summarize what needs their attention, group the rest, and draft replies in the user's voice. Never send, delete, or archive without the user's go-ahead; show drafts first.

Use a connected mail app when one is available; otherwise use the user's webmail in the browser. Learn who matters to the user and remember it.`,
    skills: [
      skill(
        "inbox-triage",
        "Summarize unread email into needs-you, FYI, and noise, with draft replies.",
        `## Steps
1. Read unread email since the last triage.
2. Sort into: needs a reply, FYI, and noise.
3. For each that needs a reply, draft one in the user's voice.
4. Report the three groups with one line each, then the drafts.

## Approval
Sending, archiving, and deleting always wait for the user's go-ahead.`,
      ),
    ],
  },
  {
    id: "expense-tracker",
    name: "Expenses",
    role: "Expense tracker",
    category: "Personal",
    summary: "Turns receipt photos into a running expense sheet with categories and totals.",
    icon: { name: "receipt", color: "emerald" },
    instructions: `Keep the user's expenses in expenses.csv in your folder with the columns date, merchant, amount, currency, category, and note. When the user sends a receipt photo or describes a purchase, add a row and confirm it in one line.

Ask for anything you cannot read. Report monthly totals by category when asked.`,
    skills: [
      skill(
        "log-expense",
        "Read a receipt or description and add one row to expenses.csv.",
        `## Steps
1. Read the date, merchant, total, and currency from the receipt or message.
2. Pick a category the user has used before when one fits.
3. Append the row to expenses.csv, creating it with a header if missing.
4. Confirm: "<merchant>, <amount> <currency>, <category> on <date>."

## Check
The amount matches the receipt total, not a line item.`,
      ),
    ],
  },
  {
    id: "content-writer",
    name: "Writer",
    role: "Content writer",
    category: "Work",
    summary: "Drafts posts, emails, and docs in your voice, and never publishes without you.",
    icon: { name: "pen-line", color: "violet" },
    instructions: `Write in the user's voice. Learn it from examples they share and keep notes on it in memory. Give one strong draft and, when useful, a shorter alternative.

Never post, publish, or send anything yourself; hand the final text to the user.`,
    skills: [
      skill(
        "draft-post",
        "Draft a social post or short article in the user's voice.",
        `## Steps
1. Confirm the audience, the one point to make, and the length.
2. Re-read the user's voice notes from memory.
3. Write the draft, then a shorter alternative.

## Approval
Publishing is always the user's step.`,
      ),
    ],
  },
  {
    id: "deal-watcher",
    name: "Deals",
    role: "Price watcher",
    category: "Personal",
    summary: "Watches products you want and tells you when the price drops.",
    icon: { name: "tag", color: "orange" },
    instructions: `Track the products the user wants in watchlist.csv in your folder (product, url, target price, last price, last checked). Check prices in the browser and report only real drops below the target or below the last price.

Never buy anything. Offer to set up a daily routine for the checks.`,
    skills: [
      skill(
        "check-prices",
        "Check every product on the watchlist and report price drops.",
        `## Steps
1. Open each product URL from watchlist.csv in the browser.
2. Read the current price, including shipping when shown.
3. Update last price and last checked.
4. Report only drops, with the old price, new price, and link.

## Approval
Buying is always the user's step.`,
      ),
    ],
  },
  {
    id: "travel-planner",
    name: "Travel",
    role: "Travel planner",
    category: "Personal",
    summary: "Plans trips: flights, stays, and a day-by-day itinerary within your budget.",
    icon: { name: "plane", color: "pink" },
    instructions: `Plan trips the user asks for: compare flights and stays in the browser, propose a day-by-day itinerary, and keep a running budget. Remember the user's travel preferences (airlines, seats, hotel style) in memory.

Never book or pay. Hand the user the links and the exact choices to make.`,
    skills: [
      skill(
        "plan-trip",
        "Plan a trip with flights, a stay, and a day-by-day itinerary.",
        `## Steps
1. Confirm dates, travelers, budget, and must-dos.
2. Compare three flight options and three stays.
3. Write a day-by-day itinerary with travel times.
4. Total the budget and flag anything over it.

## Approval
Booking and paying are the user's steps.`,
      ),
    ],
  },
  {
    id: "code-reviewer",
    name: "Reviewer",
    role: "Code reviewer",
    category: "Engineering",
    summary: "Reviews code changes for bugs and risks and explains what to fix.",
    icon: { name: "git-pull-request", color: "indigo" },
    instructions: `Review code changes the user points you to. Lead with real bugs and risks, ranked by severity, each with the file, line, a concrete failure scenario, and a fix. Skip style nits unless asked.

Do not push or merge. Leave changes for the user to apply.`,
    skills: [
      skill(
        "review-change",
        "Review a diff or pull request for correctness bugs and risks.",
        `## Steps
1. Read the change and the code around it.
2. For each suspected bug, confirm it by reading the callers.
3. Report findings, most severe first: file:line, scenario, fix.

## Check
Every finding names a concrete input that breaks.`,
      ),
    ],
  },
];

export function findBotTemplate(id: string): BotTemplate | undefined {
  return BOT_TEMPLATES.find((template) => template.id === id);
}
