// Leaving employees: consent, the AI interview, and deleting their knowledge.
//
// Nothing is collected until the person signs consent (SPEC.md: "only with company permission
// and employee consent, and only on work material"). Withdrawing consent deletes everything
// captured from them. Consent records are never edited: each signature or withdrawal is a new row.
import type { DepartingPerson, Organization } from "../generated/prisma/client.js";
import type { Db } from "../lib/prisma.js";
import { enqueue } from "../jobs/queue.js";
import { personalise, QUESTION_BANK } from "./questionBank.js";
import type { FollowUp } from "./ai.js";
import type { FileStorage } from "./storage.js";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function consentText(org: Pick<Organization, "name">, person: Pick<DepartingPerson, "name" | "role">, version: string): string {
  return `Knowledge handover consent (version ${version})

I, ${person.name}, agree that ${org.name} may use Handover to capture my WORK knowledge as ${person.role || "an employee"}, so the person who takes over my work can find answers.

What will be collected:
• My answers to an interview about my work (systems, processes, decisions, contacts, open issues).
• Work documents that I choose to upload or select from my Google Drive.

What will NOT be collected:
• Anything I don't choose to share. Nothing is read from my email, chats or files without my selection.
• Personal or private information. I will not share passwords or other people's personal data.
• My voice, writing style or personality. No "digital twin" is made of me. I am not monitored.

Who can see it: people at ${org.name} with access to Handover. Answers they get show which of my interview answers or documents they came from.

How long: until ${org.name} deletes it, or I withdraw this consent. If I withdraw, everything captured from me is deleted.

I can see everything I have shared, and withdraw at any time from my Handover page.`;
}

export interface InterviewState {
  status: DepartingPerson["interviewStatus"];
  progress: { answered: number; total: number };
  current: { key: string; section: string; text: string; isFollowUp: boolean } | null;
  history: { key: string; question: string; answer: string | null; isFollowUp: boolean; skipped: boolean }[];
}

export class PeopleService {
  constructor(
    private readonly prisma: Db,
    private readonly followUp: FollowUp,
    private readonly storage: FileStorage,
    private readonly consentVersion: string,
  ) {}

  /** A person in this organisation, or 404. */
  async inOrg(orgId: string, personId: string) {
    const p = await this.prisma.departingPerson.findFirst({ where: { id: personId, orgId }, include: { org: true } });
    if (!p) throw new AppError(404, "Person not found.");
    return p;
  }

  /** The departing-person record linked to a logged-in employee, or 404. */
  async forUser(userId: string) {
    const p = await this.prisma.departingPerson.findFirst({ where: { userId }, include: { org: true } });
    if (!p) throw new AppError(404, "You aren't set up as a leaving employee.");
    return p;
  }

  async sign(userId: string, typedName: string, ip: string | undefined) {
    const p = await this.forUser(userId);
    if (p.knowledgeDeletedAt) throw new AppError(409, "Your knowledge was deleted by your company. Ask your admin to add you again.");
    if (p.consentStatus === "signed") return p;
    const normal = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    if (normal(typedName) !== normal(p.name)) throw new AppError(400, `Type your full name exactly as shown: ${p.name}`);
    await this.prisma.consentRecord.create({
      data: { orgId: p.orgId, personId: p.id, action: "signed", scopeText: consentText(p.org, p, this.consentVersion), version: this.consentVersion, typedName, ip: ip ?? null },
    });
    return this.prisma.departingPerson.update({ where: { id: p.id }, data: { consentStatus: "signed" }, include: { org: true } });
  }

  /** Withdrawing consent deletes everything captured from the person. */
  async withdraw(userId: string, ip: string | undefined) {
    const p = await this.forUser(userId);
    if (p.consentStatus !== "signed") throw new AppError(409, "There is no signed consent to withdraw.");
    await this.prisma.consentRecord.create({
      data: { orgId: p.orgId, personId: p.id, action: "withdrawn", scopeText: "Consent withdrawn. All captured knowledge deleted.", version: this.consentVersion, typedName: p.name, ip: ip ?? null },
    });
    await this.eraseKnowledge(p.orgId, p.id);
    return this.prisma.departingPerson.update({ where: { id: p.id }, data: { consentStatus: "withdrawn", interviewStatus: "not_started" } });
  }

  /** Remove interview answers, documents (and their files) and chunks for one person. */
  async eraseKnowledge(orgId: string, personId: string) {
    const sources = await this.prisma.source.findMany({ where: { orgId, personId }, select: { fileKey: true } });
    for (const s of sources) if (s.fileKey) await this.storage.remove(s.fileKey).catch(() => undefined);
    await this.prisma.source.deleteMany({ where: { orgId, personId } }); // chunks go with them
    await this.prisma.interviewAnswer.deleteMany({ where: { orgId, personId } });
  }

  // ---------------- interview ----------------

  private async requireConsent(userId: string) {
    const p = await this.forUser(userId);
    if (p.consentStatus !== "signed") throw new AppError(403, "Please read and sign the consent first.");
    return p;
  }

  async state(personId: string): Promise<InterviewState> {
    const p = await this.prisma.departingPerson.findUniqueOrThrow({ where: { id: personId } });
    const rows = await this.prisma.interviewAnswer.findMany({ where: { personId }, orderBy: { createdAt: "asc" } });
    const doneKeys = new Set(rows.filter((r) => !r.isFollowUp).map((r) => r.questionKey));
    const openFollowUp = rows.find((r) => r.isFollowUp && r.answer === null && !r.skipped);
    const next = QUESTION_BANK.find((q) => !doneKeys.has(q.key));
    let current: InterviewState["current"] = null;
    if (openFollowUp) {
      const base = QUESTION_BANK.find((q) => q.key === openFollowUp.questionKey);
      current = { key: openFollowUp.questionKey, section: base?.section ?? "", text: openFollowUp.question, isFollowUp: true };
    } else if (next) {
      current = { key: next.key, section: next.section, text: personalise(next.text, p.role), isFollowUp: false };
    }
    return {
      status: p.interviewStatus,
      progress: { answered: doneKeys.size, total: QUESTION_BANK.length },
      current,
      history: rows.map((r) => ({ key: r.questionKey, question: r.question, answer: r.answer, isFollowUp: r.isFollowUp, skipped: r.skipped })),
    };
  }

  async answer(userId: string, answer: string | null) {
    const p = await this.requireConsent(userId);
    const s = await this.state(p.id);
    if (!s.current) throw new AppError(409, "The interview is already complete.");
    const skipped = answer === null;
    const { key, text, isFollowUp } = s.current;

    if (isFollowUp) {
      const open = await this.prisma.interviewAnswer.findFirstOrThrow({ where: { personId: p.id, questionKey: key, isFollowUp: true, answer: null, skipped: false } });
      await this.prisma.interviewAnswer.update({ where: { id: open.id }, data: skipped ? { skipped: true } : { answer } });
    } else {
      await this.prisma.interviewAnswer.create({ data: { orgId: p.orgId, personId: p.id, questionKey: key, question: text, answer, skipped } });
      // One follow-up at most per question, and only for a real answer.
      if (!skipped && answer) {
        const follow = await this.followUp({ role: p.role, question: text, answer });
        if (follow) await this.prisma.interviewAnswer.create({ data: { orgId: p.orgId, personId: p.id, questionKey: key, question: follow, isFollowUp: true } });
      }
    }
    if (!skipped) await enqueue(this.prisma, "ingest_interview", { personId: p.id, questionKey: key });

    const after = await this.state(p.id);
    const status = after.current ? "in_progress" : "completed";
    if (status !== p.interviewStatus) await this.prisma.departingPerson.update({ where: { id: p.id }, data: { interviewStatus: status } });
    return this.state(p.id);
  }

  /** Let the person change an earlier answer (the knowledge base is rebuilt for that question). */
  async edit(userId: string, key: string, isFollowUp: boolean, answer: string) {
    const p = await this.requireConsent(userId);
    const row = await this.prisma.interviewAnswer.findFirst({ where: { personId: p.id, questionKey: key, isFollowUp } });
    if (!row) throw new AppError(404, "Answer not found.");
    await this.prisma.interviewAnswer.update({ where: { id: row.id }, data: { answer, skipped: false } });
    await enqueue(this.prisma, "ingest_interview", { personId: p.id, questionKey: key });
    return this.state(p.id);
  }

  /** Builds the text for one question (base + follow-up) — used by the ingest job. */
  async interviewText(personId: string, key: string) {
    const rows = await this.prisma.interviewAnswer.findMany({ where: { personId, questionKey: key, skipped: false, answer: { not: null } }, orderBy: { createdAt: "asc" } });
    return rows.map((r) => `Q: ${r.question}\nA: ${r.answer}`).join("\n\n");
  }
}
