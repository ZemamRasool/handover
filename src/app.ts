// Builds the web app: security headers, rate limits, permissions, routes and pages.
// Everything it needs is passed in, so tests can swap the AI, embeddings, Drive and email for fakes.
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import type { Config } from "./config.js";
import type { Db } from "./lib/prisma.js";
import { Encryptor } from "./lib/crypto.js";
import type { AuthBackend } from "./auth/verifyToken.js";
import { requireAuth, requireOrg, requireRole } from "./middleware/requireAuth.js";
import { FileStorage } from "./services/storage.js";
import { Knowledge } from "./services/knowledge.js";
import { PeopleService } from "./services/people.js";
import type { Embedder } from "./services/embeddings.js";
import type { Answerer, FollowUp } from "./services/ai.js";
import type { DriveApi } from "./services/drive.js";
import type { Mailer } from "./services/mailer.js";
import { teamRouter } from "./routes/team.js";
import { employeeRouter } from "./routes/employee.js";
import { adminRouter } from "./routes/admin.js";

export interface AppDeps {
  config: Config;
  prisma: Db;
  auth: AuthBackend;
  embed: Embedder;
  answer: Answerer;
  followUp: FollowUp;
  drive: DriveApi;
  mailer: Mailer;
}

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

export function createServices(d: AppDeps) {
  const crypto = new Encryptor(d.config.ENCRYPTION_KEY);
  const storage = new FileStorage(d.config.UPLOAD_DIR, crypto);
  const knowledge = new Knowledge(d.prisma, d.embed, d.answer, d.config.MIN_RELEVANCE);
  const people = new PeopleService(d.prisma, d.followUp, storage, d.config.CONSENT_VERSION);
  return { crypto, storage, knowledge, people };
}

export function createApp(deps: AppDeps) {
  const { config, prisma, auth } = deps;
  const { crypto, storage, knowledge, people } = createServices(deps);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "https://www.gstatic.com", "https://apis.google.com"],
          connectSrc: ["'self'", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com", "https://www.googleapis.com"],
          frameSrc: ["https://*.firebaseapp.com", "https://accounts.google.com"],
          imgSrc: ["'self'", "data:"],
          styleSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.NODE_ENV === "production" ? [] : null,
        },
      },
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
      hsts: config.NODE_ENV === "production",
      referrerPolicy: { policy: "no-referrer" },
    }),
  );

  const limiter = (windowMinutes: number, limit: number) =>
    rateLimit({
      windowMs: windowMinutes * 60_000,
      limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (req) => (req.user ? `u:${req.user.id}` : ipKeyGenerator(req.ip ?? "")),
      message: { error: "Too many requests. Please wait a little and try again." },
    });

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/api/config", (_req, res) =>
    res.json({ authMode: config.AUTH_MODE, firebase: { apiKey: config.FIREBASE_WEB_API_KEY, authDomain: config.FIREBASE_WEB_AUTH_DOMAIN, projectId: config.FIREBASE_PROJECT_ID } }),
  );

  app.use("/api", limiter(15, 900), express.json({ limit: "200kb" }), requireAuth(prisma, auth));
  // Each AI call costs money: cap questions and interview answers per user.
  app.post("/api/ask", limiter(60, 120));
  app.post("/api/my/interview/answer", limiter(60, 200));
  // Leaving employees: only their own pages.
  app.use("/api/my", requireOrg, requireRole(prisma, "employee"));
  // Admins: only their own organisation.
  app.use("/api/admin", requireOrg, requireRole(prisma, "admin"));

  app.use(teamRouter(prisma, config, knowledge));
  app.use(employeeRouter(prisma, config, crypto, people, storage, deps.drive));
  app.use("/api/admin", adminRouter(prisma, config, people, storage, auth));
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(express.static(publicDir, { extensions: ["html"] }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { type?: string };
    if (e?.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
    if (e?.type === "entity.too.large") return res.status(413).json({ error: "Request is too large." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  return app;
}
