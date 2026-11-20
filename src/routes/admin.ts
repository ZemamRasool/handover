// Admin of ONE organisation. Every query below filters by the admin's own org_id.
//   GET    /api/admin/overview
//   GET    /api/admin/people ; POST /api/admin/people (add a leaving employee → they get an invitation)
//   GET    /api/admin/people/:id                (transcript, documents, consent history)
//   POST   /api/admin/people/:id/delete-knowledge
//   GET    /api/admin/users ; POST /api/admin/users (invite) ; PATCH /api/admin/users/:id (role / disable)
//   GET    /api/admin/questions                 (quality review: unknowns and 👎 answers)
//   GET    /api/admin/audit
//   GET    /api/admin/export                    (everything, as JSON)
//   POST   /api/admin/org/delete                (delete the organisation and all its data)
//   GET    /api/admin/jobs ; POST /api/admin/sources/:id/retry
import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import { enqueue } from "../jobs/queue.js";
import { AppError, type PeopleService } from "../services/people.js";
import { QUESTION_BANK } from "../services/questionBank.js";
import type { FileStorage } from "../services/storage.js";
import type { AuthBackend } from "../auth/verifyToken.js";
import { handle, orgOf, parse } from "./common.js";

export function adminRouter(prisma: Db, config: Config, people: PeopleService, storage: FileStorage, auth: AuthBackend) {
  const router = Router();
  const p = (v: unknown) => String(v);
  const mail = (to: string, subject: string, text: string) => enqueue(prisma, "send_email", { to, subject: `Handover: ${subject}`, text });

  router.get(
    "/overview",
    handle(async (req, res) => {
      const org = orgOf(req);
      const [people, consent, interview, sources, chunks, questions, unknown, bad, users] = await Promise.all([
        prisma.departingPerson.count({ where: { orgId: org } }),
        prisma.departingPerson.groupBy({ by: ["consentStatus"], where: { orgId: org }, _count: { _all: true } }),
        prisma.departingPerson.groupBy({ by: ["interviewStatus"], where: { orgId: org, consentStatus: "signed" }, _count: { _all: true } }),
        prisma.source.count({ where: { orgId: org, type: { not: "interview" } } }),
        prisma.chunk.count({ where: { orgId: org } }),
        prisma.question.count({ where: { orgId: org } }),
        prisma.question.count({ where: { orgId: org, known: false } }),
        prisma.question.count({ where: { orgId: org, rating: -1 } }),
        prisma.user.count({ where: { orgId: org, disabled: false } }),
      ]);
      res.json({
        people,
        consent: Object.fromEntries(consent.map((r) => [r.consentStatus, r._count._all])),
        interview: Object.fromEntries(interview.map((r) => [r.interviewStatus, r._count._all])),
        documents: sources,
        chunks,
        questions,
        unknownAnswers: unknown,
        badAnswers: bad,
        users,
      });
    }),
  );

  router.get(
    "/people",
    handle(async (req, res) => {
      const rows = await prisma.departingPerson.findMany({
        where: { orgId: orgOf(req) },
        include: { _count: { select: { sources: true, interviews: true } } },
        orderBy: { createdAt: "desc" },
      });
      res.json(
        rows.map((x) => ({
          id: x.id,
          name: x.name,
          email: x.email,
          role: x.role,
          team: x.team,
          lastDay: x.lastDay,
          consentStatus: x.consentStatus,
          interviewStatus: x.interviewStatus,
          knowledgeDeleted: Boolean(x.knowledgeDeletedAt),
          sources: x._count.sources,
          answers: x._count.interviews,
        })),
      );
    }),
  );

  router.post(
    "/people",
    handle(async (req, res) => {
      const b = parse(
        z.object({
          name: z.string().trim().min(2).max(120),
          email: z.string().trim().toLowerCase().email(),
          role: z.string().trim().min(2).max(120),
          team: z.string().trim().max(120).optional(),
          lastDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }),
        req.body,
      );
      const org = orgOf(req);
      const existing = await prisma.user.findUnique({ where: { email: b.email } });
      if (existing && existing.orgId && existing.orgId !== org) throw new AppError(409, "This email already belongs to another organisation.");
      if (existing && existing.role !== "employee" && existing.orgId === org) throw new AppError(409, "This email is already a team member. Use a different email for the leaving employee.");
      const user = existing
        ? await prisma.user.update({ where: { id: existing.id }, data: { orgId: org, role: "employee", name: b.name, disabled: false } })
        : await prisma.user.create({ data: { email: b.email, firebaseUid: `pending:${b.email}`, orgId: org, role: "employee", name: b.name } });
      if (await prisma.departingPerson.findFirst({ where: { userId: user.id } })) throw new AppError(409, "This person has already been added.");
      const person = await prisma.departingPerson.create({
        data: { orgId: org, userId: user.id, name: b.name, email: b.email, role: b.role, team: b.team ?? null, lastDay: b.lastDay ? new Date(`${b.lastDay}T00:00:00Z`) : null },
      });
      const o = await prisma.organization.findUniqueOrThrow({ where: { id: org } });
      await mail(
        b.email,
        `${o.name} would like to capture your handover`,
        `Hi ${b.name},\n\nBefore you leave, ${o.name} would like to save what you know about your work, so the next person isn't starting from zero.\n\nIt takes about an hour: a guided interview (25 questions, skip any you like) and, if you want, a few work documents.\n\nFirst you'll read exactly what is collected and who can see it, and decide whether to agree. Nothing is collected without your consent, and you can withdraw it at any time.\n\nStart here: ${config.PUBLIC_BASE_URL}/app`,
      );
      await audit(prisma, req, { action: "person.add", targetType: "person", targetId: person.id });
      res.status(201).json({ id: person.id });
    }),
  );

  router.get(
    "/people/:id",
    handle(async (req, res) => {
      const person = await people.inOrg(orgOf(req), p(req.params.id));
      const [answers, sources, consents] = await Promise.all([
        prisma.interviewAnswer.findMany({ where: { orgId: person.orgId, personId: person.id }, orderBy: { createdAt: "asc" } }),
        prisma.source.findMany({ where: { orgId: person.orgId, personId: person.id }, orderBy: { createdAt: "desc" }, include: { _count: { select: { chunks: true } } } }),
        prisma.consentRecord.findMany({ where: { orgId: person.orgId, personId: person.id }, orderBy: { signedAt: "asc" } }),
      ]);
      await audit(prisma, req, { action: "person.view", targetType: "person", targetId: person.id });
      res.json({
        id: person.id,
        name: person.name,
        email: person.email,
        role: person.role,
        team: person.team,
        lastDay: person.lastDay,
        consentStatus: person.consentStatus,
        interviewStatus: person.interviewStatus,
        knowledgeDeletedAt: person.knowledgeDeletedAt,
        progress: { answered: new Set(answers.filter((a) => !a.isFollowUp).map((a) => a.questionKey)).size, total: QUESTION_BANK.length },
        transcript: answers.map((a) => ({ key: a.questionKey, question: a.question, answer: a.answer, isFollowUp: a.isFollowUp, skipped: a.skipped })),
        sources: sources.map((s) => ({ id: s.id, type: s.type, title: s.title, status: s.status, error: s.error, chunks: s._count.chunks, link: s.link })),
        consents: consents.map((c) => ({ action: c.action, version: c.version, typedName: c.typedName, signedAt: c.signedAt, scopeText: c.scopeText })),
      });
    }),
  );

  router.post(
    "/people/:id/delete-knowledge",
    handle(async (req, res) => {
      const person = await people.inOrg(orgOf(req), p(req.params.id));
      await people.eraseKnowledge(person.orgId, person.id);
      await prisma.departingPerson.update({ where: { id: person.id }, data: { knowledgeDeletedAt: new Date(), interviewStatus: "not_started" } });
      if (person.userId) await prisma.user.update({ where: { id: person.userId }, data: { disabled: true, googleTokenEnc: null } });
      await audit(prisma, req, { action: "person.delete_knowledge", targetType: "person", targetId: person.id });
      res.json({ ok: true });
    }),
  );

  router.get(
    "/users",
    handle(async (req, res) => {
      const rows = await prisma.user.findMany({ where: { orgId: orgOf(req) }, orderBy: { createdAt: "asc" } });
      res.json(rows.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, disabled: u.disabled, joined: !u.firebaseUid.startsWith("pending:"), createdAt: u.createdAt })));
    }),
  );

  router.post(
    "/users",
    handle(async (req, res) => {
      const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), name: z.string().trim().min(2).max(120), role: z.enum(["admin", "reader"]) }), req.body);
      const existing = await prisma.user.findUnique({ where: { email: b.email } });
      if (existing) throw new AppError(409, existing.orgId === orgOf(req) ? "Already a member." : "This email already belongs to another organisation.");
      const u = await prisma.user.create({ data: { email: b.email, name: b.name, role: b.role, orgId: orgOf(req), firebaseUid: `pending:${b.email}` } });
      const o = await prisma.organization.findUniqueOrThrow({ where: { id: orgOf(req) } });
      await mail(b.email, `You've been invited to ${o.name}`, `Hi ${b.name},\n\nYou've been invited to ${o.name}'s Handover workspace, where you can ask questions and get answers from colleagues' captured knowledge.\n\nLog in with this email: ${config.PUBLIC_BASE_URL}/app`);
      await audit(prisma, req, { action: "user.invite", targetType: "user", targetId: u.id, meta: { role: b.role } });
      res.status(201).json({ id: u.id });
    }),
  );

  router.patch(
    "/users/:id",
    handle(async (req, res) => {
      const b = parse(z.object({ role: z.enum(["admin", "reader"]).optional(), disabled: z.boolean().optional() }), req.body);
      const u = await prisma.user.findFirst({ where: { id: p(req.params.id), orgId: orgOf(req) } });
      if (!u) throw new AppError(404, "User not found.");
      if (u.id === req.user!.id) throw new AppError(400, "You can't change your own access.");
      if (u.role === "employee" && b.role) throw new AppError(400, "Leaving employees are managed under People.");
      await prisma.user.update({ where: { id: u.id }, data: b });
      await audit(prisma, req, { action: "user.update", targetType: "user", targetId: u.id, meta: b });
      res.json({ ok: true });
    }),
  );

  router.get(
    "/questions",
    handle(async (req, res) => {
      const filter = req.query.filter === "problems" ? { OR: [{ known: false }, { rating: -1 }] } : {};
      const rows = await prisma.question.findMany({ where: { orgId: orgOf(req), ...filter }, include: { asker: { select: { email: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
      res.json(rows.map((q) => ({ id: q.id, asker: q.asker.email, question: q.question, answer: q.answer, known: q.known, rating: q.rating, citations: q.citationsJson, createdAt: q.createdAt })));
    }),
  );

  router.get(
    "/audit",
    handle(async (req, res) => {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      res.json(await prisma.auditLog.findMany({ where: { orgId: orgOf(req) }, orderBy: { createdAt: "desc" }, take: limit }));
    }),
  );

  router.get(
    "/export",
    handle(async (req, res) => {
      const org = orgOf(req);
      const [organization, users, departing, consents, interviews, sources, questions] = await Promise.all([
        prisma.organization.findUnique({ where: { id: org } }),
        prisma.user.findMany({ where: { orgId: org }, select: { id: true, email: true, name: true, role: true, disabled: true, createdAt: true } }),
        prisma.departingPerson.findMany({ where: { orgId: org } }),
        prisma.consentRecord.findMany({ where: { orgId: org } }),
        prisma.interviewAnswer.findMany({ where: { orgId: org }, orderBy: { createdAt: "asc" } }),
        prisma.source.findMany({ where: { orgId: org }, include: { chunks: { select: { position: true, text: true }, orderBy: { position: "asc" } } } }),
        prisma.question.findMany({ where: { orgId: org } }),
      ]);
      await audit(prisma, req, { action: "org.export", targetType: "organization", targetId: org });
      res.setHeader("Content-Disposition", 'attachment; filename="handover-export.json"');
      res.json({
        exportedAt: new Date(),
        organization,
        users,
        departingPeople: departing,
        consentRecords: consents,
        interviews,
        sources: sources.map(({ fileKey: _f, chunks, ...s }) => ({ ...s, text: chunks.map((c) => c.text).join("\n\n") })),
        questions,
      });
    }),
  );

  router.post(
    "/org/delete",
    handle(async (req, res) => {
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgOf(req) } });
      const { confirm } = parse(z.object({ confirm: z.string() }), req.body);
      if (confirm !== org.name) throw new AppError(400, `Type the organisation name exactly to confirm: ${org.name}`);
      const members = await prisma.user.findMany({ where: { orgId: org.id }, select: { firebaseUid: true } });
      await storage.removeOrg(org.id);
      await audit(prisma, req, { action: "org.delete", targetType: "organization", targetId: org.id, meta: { name: org.name } });
      await prisma.organization.delete({ where: { id: org.id } }); // people, sources, chunks, questions, users go with it
      for (const m of members) if (!m.firebaseUid.startsWith("pending:")) await auth.deleteUser(m.firebaseUid);
      res.json({ ok: true });
    }),
  );

  router.get(
    "/jobs",
    handle(async (req, res) => {
      // Failed documents for this org (jobs themselves are not org-tagged, so we show the sources).
      const failed = await prisma.source.findMany({ where: { orgId: orgOf(req), status: "failed" }, include: { person: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 100 });
      res.json(failed.map((s) => ({ id: s.id, title: s.title, person: s.person.name, error: s.error })));
    }),
  );

  router.post(
    "/sources/:id/retry",
    handle(async (req, res) => {
      const s = await prisma.source.findFirst({ where: { id: p(req.params.id), orgId: orgOf(req), status: "failed" } });
      if (!s) throw new AppError(404, "Failed document not found.");
      await prisma.source.update({ where: { id: s.id }, data: { status: "processing", error: null } });
      await enqueue(prisma, "ingest_source", { sourceId: s.id });
      res.json({ ok: true });
    }),
  );

  return router;
}
