// The leaving employee's own pages. Everything here works ONLY on the logged-in person's own record.
//   GET  /api/my/consent              the consent text + status
//   POST /api/my/consent              sign (type your full name)
//   POST /api/my/consent/withdraw     withdraw → everything captured is deleted
//   GET  /api/my/interview            progress, current question, history
//   POST /api/my/interview/answer     { answer }   (or { skip: true })
//   PUT  /api/my/interview/answer     { key, isFollowUp, answer }  change an earlier answer
//   GET  /api/my/sources ; POST /api/my/sources (upload, field "file") ; DELETE /api/my/sources/:id
//   GET  /api/my/drive/connect ; GET /api/my/drive/files?q= ; POST /api/my/drive/import ; DELETE /api/my/drive
//   GET  /auth/google/callback        (Google sends the browser back here)
import { createHmac } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Db } from "../lib/prisma.js";
import type { Encryptor } from "../lib/crypto.js";
import { audit } from "../lib/audit.js";
import { enqueue } from "../jobs/queue.js";
import { sign, verifySigned } from "../lib/signed.js";
import { AppError, consentText, type PeopleService } from "../services/people.js";
import type { FileStorage } from "../services/storage.js";
import type { DriveApi } from "../services/drive.js";
import { sniffDoc } from "../services/extract.js";
import { handle, parse } from "./common.js";

export function employeeRouter(prisma: Db, config: Config, crypto: Encryptor, people: PeopleService, storage: FileStorage, drive: DriveApi) {
  const router = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
  const stateSecret = createHmac("sha256", config.ENCRYPTION_KEY).update("google-oauth-state").digest("hex");
  const redirectUri = `${config.PUBLIC_BASE_URL}/auth/google/callback`;

  router.get(
    "/api/my/consent",
    handle(async (req, res) => {
      const p = await people.forUser(req.user!.id);
      const records = await prisma.consentRecord.findMany({ where: { personId: p.id }, orderBy: { signedAt: "asc" }, select: { action: true, version: true, signedAt: true } });
      res.json({ person: { name: p.name, role: p.role, org: p.org.name, lastDay: p.lastDay }, status: p.consentStatus, version: config.CONSENT_VERSION, text: consentText(p.org, p, config.CONSENT_VERSION), records });
    }),
  );

  router.post(
    "/api/my/consent",
    handle(async (req, res) => {
      const b = parse(z.object({ typedName: z.string().trim().min(2).max(120), agree: z.literal(true) }), req.body);
      const p = await people.sign(req.user!.id, b.typedName, req.ip);
      await audit(prisma, req, { action: "consent.sign", targetType: "person", targetId: p.id, meta: { version: config.CONSENT_VERSION } });
      res.json({ status: p.consentStatus });
    }),
  );

  router.post(
    "/api/my/consent/withdraw",
    handle(async (req, res) => {
      const p = await people.withdraw(req.user!.id, req.ip);
      await audit(prisma, req, { action: "consent.withdraw", targetType: "person", targetId: p.id });
      res.json({ status: p.consentStatus });
    }),
  );

  router.get(
    "/api/my/interview",
    handle(async (req, res) => {
      const p = await people.forUser(req.user!.id);
      res.json({ consent: p.consentStatus, ...(await people.state(p.id)) });
    }),
  );

  router.post(
    "/api/my/interview/answer",
    handle(async (req, res) => {
      const b = parse(z.union([z.object({ answer: z.string().trim().min(1).max(10_000) }), z.object({ skip: z.literal(true) })]), req.body);
      const state = await people.answer(req.user!.id, "answer" in b ? b.answer : null);
      res.json(state);
    }),
  );

  router.put(
    "/api/my/interview/answer",
    handle(async (req, res) => {
      const b = parse(z.object({ key: z.string().max(60), isFollowUp: z.boolean(), answer: z.string().trim().min(1).max(10_000) }), req.body);
      res.json(await people.edit(req.user!.id, b.key, b.isFollowUp, b.answer));
    }),
  );

  // ---------------- documents ----------------
  const mySources = async (personId: string) =>
    (await prisma.source.findMany({ where: { personId, type: { not: "interview" } }, orderBy: { createdAt: "desc" } })).map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      link: s.link,
      status: s.status,
      error: s.error,
      createdAt: s.createdAt,
    }));

  router.get(
    "/api/my/sources",
    handle(async (req, res) => {
      const p = await people.forUser(req.user!.id);
      res.json(await mySources(p.id));
    }),
  );

  router.post(
    "/api/my/sources",
    (req, res, next) =>
      upload.single("file")(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: `Files must be under ${config.MAX_UPLOAD_MB} MB.` });
        if (err) return next(err);
        next();
      }),
    handle(async (req, res) => {
      const p = await people.forUser(req.user!.id);
      if (p.consentStatus !== "signed") throw new AppError(403, "Please sign the consent first.");
      const f = req.file;
      if (!f || !f.size) throw new AppError(400, "Choose a file.");
      const type = sniffDoc(f.buffer, f.originalname);
      if (!type) throw new AppError(415, "Upload a PDF, Word (.docx), text or Markdown file.");
      const fileKey = await storage.save(p.orgId, f.buffer);
      const s = await prisma.source.create({ data: { orgId: p.orgId, personId: p.id, type: "upload", title: f.originalname.slice(0, 200), mimeType: type, fileKey } });
      await enqueue(prisma, "ingest_source", { sourceId: s.id });
      await audit(prisma, req, { action: "source.upload", targetType: "source", targetId: s.id });
      res.status(202).json({ id: s.id, status: s.status });
    }),
  );

  router.delete(
    "/api/my/sources/:id",
    handle(async (req, res) => {
      const p = await people.forUser(req.user!.id);
      const s = await prisma.source.findFirst({ where: { id: String(req.params.id), personId: p.id, type: { not: "interview" } } });
      if (!s) throw new AppError(404, "Document not found.");
      if (s.fileKey) await storage.remove(s.fileKey).catch(() => undefined);
      await prisma.source.delete({ where: { id: s.id } });
      await audit(prisma, req, { action: "source.delete", targetType: "source", targetId: s.id });
      res.json({ ok: true });
    }),
  );

  // ---------------- Google Drive ----------------
  router.get(
    "/api/my/drive/connect",
    handle(async (req, res) => {
      if (!config.GOOGLE_CLIENT_ID) throw new AppError(503, "Google Drive isn't set up on this server yet.");
      const p = await people.forUser(req.user!.id);
      if (p.consentStatus !== "signed") throw new AppError(403, "Please sign the consent first.");
      res.json({ url: drive.authorizeUrl(sign(req.user!.id, stateSecret, 600), redirectUri) });
    }),
  );

  router.get(
    "/auth/google/callback",
    handle(async (req, res) => {
      const userId = typeof req.query.state === "string" ? verifySigned(req.query.state, stateSecret) : null;
      const code = typeof req.query.code === "string" ? req.query.code : null;
      if (!userId || !code) return res.redirect("/app#documents?drive=failed");
      const refresh = await drive.exchangeCode(code, redirectUri);
      if (!refresh) return res.redirect("/app#documents?drive=failed");
      const u = await prisma.user.update({ where: { id: userId }, data: { googleTokenEnc: crypto.encryptText(refresh) } });
      await audit(prisma, { user: u, ip: req.ip }, { action: "drive.connect", targetType: "user", targetId: userId });
      res.redirect("/app#documents?drive=connected");
    }),
  );

  const driveToken = (enc: string | null) => {
    if (!enc) throw new AppError(412, "Connect Google Drive first.");
    return crypto.decryptText(enc);
  };

  router.get(
    "/api/my/drive/files",
    handle(async (req, res) => {
      await people.forUser(req.user!.id);
      const q = typeof req.query.q === "string" ? req.query.q.slice(0, 100) : "";
      res.json(await drive.list(driveToken(req.user!.googleTokenEnc), q));
    }),
  );

  router.post(
    "/api/my/drive/import",
    handle(async (req, res) => {
      const { fileIds } = parse(z.object({ fileIds: z.array(z.string().min(5).max(200)).min(1).max(25) }), req.body);
      const p = await people.forUser(req.user!.id);
      if (p.consentStatus !== "signed") throw new AppError(403, "Please sign the consent first.");
      const token = driveToken(req.user!.googleTokenEnc);
      const files = await drive.list(token, "");
      const known = new Map(files.map((f) => [f.id, f]));
      let created = 0;
      for (const id of fileIds) {
        const exists = await prisma.source.findFirst({ where: { personId: p.id, type: "google_drive", externalId: id } });
        if (exists) continue;
        const f = known.get(id);
        const s = await prisma.source.create({
          data: { orgId: p.orgId, personId: p.id, type: "google_drive", externalId: id, title: (f?.name ?? "Google Drive file").slice(0, 200), link: f?.webViewLink ?? null, mimeType: f?.mimeType ?? null },
        });
        await enqueue(prisma, "ingest_source", { sourceId: s.id });
        created++;
      }
      await audit(prisma, req, { action: "drive.import", targetType: "person", targetId: p.id, meta: { files: created } });
      res.status(202).json({ imported: created });
    }),
  );

  router.delete(
    "/api/my/drive",
    handle(async (req, res) => {
      await prisma.user.update({ where: { id: req.user!.id }, data: { googleTokenEnc: null } });
      await audit(prisma, req, { action: "drive.disconnect", targetType: "user", targetId: req.user!.id });
      res.json({ ok: true });
    }),
  );

  return router;
}
