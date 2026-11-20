// The exit interview: 25 fixed questions (SPEC.md "Interview engine: a fixed question bank
// plus AI follow-up questions"). {role} is replaced with the person's job title.
export interface BankQuestion {
  key: string;
  section: string;
  text: string;
}

export const QUESTION_BANK: BankQuestion[] = [
  { key: "role_summary", section: "Your role", text: "In a few sentences, what do you actually do as {role}, day to day and week to week?" },
  { key: "owned_systems", section: "Your role", text: "Which systems, services, documents or processes do you own, where you are the person people come to?" },
  { key: "recurring_tasks", section: "Your role", text: "What recurring tasks do you do (daily, weekly, monthly, yearly) that would quietly stop if nobody picked them up?" },
  { key: "deadlines", section: "Your role", text: "Are there upcoming deadlines, renewals or commitments in the next 3–6 months that the next person must know about?" },
  { key: "how_it_works", section: "How things really work", text: "Pick the most important system you work on. How does it really work, beyond what any documentation says?" },
  { key: "fragile", section: "How things really work", text: "What is fragile? What breaks most often, and what do you do when it does?" },
  { key: "workarounds", section: "How things really work", text: "What workarounds, manual steps or 'temporary' fixes are in place that people might not know about?" },
  { key: "hidden_places", section: "How things really work", text: "Where are important things hidden: scripts, spreadsheets, folders, dashboards, bookmarks, cron jobs?" },
  { key: "access", section: "How things really work", text: "Which tools, accounts and admin rights does your work need? (Names only, never passwords.)" },
  { key: "decisions", section: "Decisions and history", text: "What are the 2–3 most important decisions made in your area, and why were they made that way?" },
  { key: "tried_failed", section: "Decisions and history", text: "What has been tried before and didn't work, so the next person doesn't repeat it?" },
  { key: "tech_debt", section: "Decisions and history", text: "What known problems or debt are you leaving behind, and how urgent is each one?" },
  { key: "people_internal", section: "People", text: "Who inside the company should the next person talk to, and about what?" },
  { key: "people_external", section: "People", text: "Which customers, vendors or partners do you deal with, and what should the next person know about each relationship?" },
  { key: "escalations", section: "People", text: "When something goes wrong in your area, who do you call, and in what order?" },
  { key: "undocumented", section: "Unwritten knowledge", text: "What do you know that is written down nowhere?" },
  { key: "common_questions", section: "Unwritten knowledge", text: "What questions do people ask you most often, and what are the answers?" },
  { key: "gotchas", section: "Unwritten knowledge", text: "What mistakes are easy to make in your work? What surprised you when you started?" },
  { key: "numbers", section: "Unwritten knowledge", text: "Which numbers, limits or thresholds matter in your work (costs, quotas, SLAs, sizes)?" },
  { key: "first_week", section: "For your successor", text: "If you were starting fresh in this job, what would you do in your first week?" },
  { key: "would_fix", section: "For your successor", text: "If you had another month here, what would you fix or improve, and why?" },
  { key: "priorities", section: "For your successor", text: "What should the next person focus on first, and what can safely wait?" },
  { key: "docs_to_read", section: "For your successor", text: "Which documents, tickets or code should the next person read first? (You can also upload them.)" },
  { key: "risks", section: "For your successor", text: "What risks keep you up at night about your area after you leave?" },
  { key: "anything_else", section: "Wrapping up", text: "Is there anything else the next person must know that we haven't asked about?" },
];

export function personalise(text: string, role: string): string {
  return text.replace("{role}", role || "your role");
}
