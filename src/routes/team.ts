// Account, asking questions, and the people directory.
//   GET  /api/me                      who am I, my role, my organisation
//   POST /api/org                     create my organisation (I become its admin)
//   POST /api/ask                     ask a question → answer with citations, or "I don't know"   (admin, reader)
//   GET  /api/questions               my earlier questions
//   POST /api/questions/:id/rate      👍 / 👎 an answer
//   GET  /api/people                  whose knowledge is available                               (admin, reader)
//   GET  /api/sources/:id             read one cited source in full                              (admin, reader)
import { Router } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import type { Knowledge } from "../services/knowledge.js";
import { AppError } from "../services/people.js";
import { handle, orgOf, parse } from "./common.js";
import { requireOrg, requireRole } from "../middleware/requireAuth.js";

export function teamRouter(prisma: Db, config: Config, knowledge: Knowledge) {
  const router = Router();
  const askers = [requireOrg, requireRole(prisma, "admin", "reader")];

  router.get(
    "/api/me",
    handle(async (req, res) => {
      const u = req.user!;
      const org = u.orgId ? await prisma.organization.findUnique({ where: { id: u.orgId } }) : null;
      const person = u.role === "employee" ? await prisma.departingPerson.findFirst({ where: { userId: u.id }, select: { id: true, name: true, consentStatus: true, interviewStatus: true } }) : null;
      res.json({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        org: org ? { id: org.id, name: org.name, plan: org.plan, dataRegion: org.dataRegion } : null,
        person,
        driveConnected: Boolean(u.googleTokenEnc),
        driveEnabled: Boolean(config.GOOGLE_CLIENT_ID),
      });
    }),
  );

  router.post(
    "/api/org",
    handle(async (req, res) => {
      const b = parse(z.object({ name: z.string().trim().min(2).max(120), yourName: z.string().trim().min(2).max(120), dataRegion: z.enum(["eu", "us", "uk", "asia"]).default("eu") }), req.body);
      if (req.user!.orgId) throw new AppError(409, "You already belong to an organisation.");
      const org = await prisma.organization.create({ data: { name: b.name, dataRegion: b.dataRegion } });
      const u = await prisma.user.update({ where: { id: req.user!.id }, data: { orgId: org.id, role: "admin", name: b.yourName } });
      await audit(prisma, { user: u, ip: req.ip }, { action: "org.create", targetType: "organization", targetId: org.id });
      res.status(201).json({ id: org.id, name: org.name });
    }),
  );

  router.post(
    "/api/ask",
    ...askers,
    handle(async (req, res) => {
      const { question } = parse(z.object({ question: z.string().trim().min(3).max(1000) }), req.body);
      const result = await knowledge.ask(orgOf(req), req.user!.id, question);
      await audit(prisma, req, { action: "question.ask", targetType: "question", targetId: result.id, meta: { known: result.known } });
      res.json(result);
    }),
  );

  router.get(
    "/api/questions",
    ...askers,
    handle(async (req, res) => {
      const rows = await prisma.question.findMany({ where: { orgId: orgOf(req), askerId: req.user!.id }, orderBy: { createdAt: "desc" }, take: 50 });
      res.json(rows.map((q) => ({ id: q.id, question: q.question, answer: q.answer, known: q.known, citations: q.citationsJson, rating: q.rating, createdAt: q.createdAt })));
    }),
  );

  router.post(
    "/api/questions/:id/rate",
    ...askers,
    handle(async (req, res) => {
      const { rating } = parse(z.object({ rating: z.union([z.literal(1), z.literal(-1)]) }), req.body);
      const r = await prisma.question.updateMany({ where: { id: String(req.params.id), orgId: orgOf(req), askerId: req.user!.id }, data: { rating } });
      if (!r.count) throw new AppError(404, "Question not found.");
      res.json({ ok: true });
    }),
  );

  router.get(
    "/api/people",
    ...askers,
    handle(async (req, res) => {
      const rows = await prisma.departingPerson.findMany({
        where: { orgId: orgOf(req), consentStatus: "signed", knowledgeDeletedAt: null },
        include: { _count: { select: { sources: true } } },
        orderBy: { createdAt: "desc" },
      });
      res.json(rows.map((p) => ({ id: p.id, name: p.name, role: p.role, team: p.team, lastDay: p.lastDay, interviewStatus: p.interviewStatus, sources: p._count.sources })));
    }),
  );

  router.get(
    "/api/sources/:id",
    ...askers,
    handle(async (req, res) => {
      const s = await prisma.source.findFirst({
        where: { id: String(req.params.id), orgId: orgOf(req), status: "ready", person: { consentStatus: "signed", knowledgeDeletedAt: null } },
        include: { chunks: { orderBy: { position: "asc" }, select: { text: true } }, person: { select: { name: true, role: true } } },
      });
      if (!s) throw new AppError(404, "Source not found.");
      await audit(prisma, req, { action: "source.view", targetType: "source", targetId: s.id });
      res.json({ id: s.id, title: s.title, type: s.type, link: s.link, person: s.person, text: s.chunks.map((c) => c.text).join("\n\n"), ingestedAt: s.ingestedAt });
    }),
  );

  return router;
}
