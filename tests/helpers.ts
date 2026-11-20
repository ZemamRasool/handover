// Builds the app with local embeddings, a fake AI and a fake Google Drive.
import request from "supertest";
import { loadConfig } from "../src/config.js";
import { createApp, createServices, type AppDeps } from "../src/app.js";
import { createPrisma } from "../src/lib/prisma.js";
import { createAuthBackend } from "../src/auth/verifyToken.js";
import { createHandlers } from "../src/jobs/handlers.js";
import { Worker } from "../src/jobs/queue.js";
import { hashEmbedder } from "../src/services/embeddings.js";
import { extractiveAnswerer, simpleFollowUp, type Answerer } from "../src/services/ai.js";
import type { DriveApi } from "../src/services/drive.js";
import { QUESTION_BANK } from "../src/services/questionBank.js";

export const config = loadConfig();
export const prisma = createPrisma(config.DATABASE_URL);
type App = Parameters<typeof request>[0];

export function fakeDrive(): DriveApi {
  const files = [
    { id: "doc-runbook-1", name: "Deploy runbook", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-01T00:00:00Z", webViewLink: "https://docs.google.com/document/d/doc-runbook-1" },
  ];
  return {
    authorizeUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    exchangeCode: async (code) => (code === "good-code" ? "refresh-123" : null),
    list: async (token) => {
      if (token !== "refresh-123") throw new Error("bad token");
      return files;
    },
    fetch: async (token, id) =>
      token === "refresh-123" && id === files[0].id
        ? { file: files[0], kind: "text", data: Buffer.from("To deploy the billing service, run make release from the ops repo, then watch the Grafana billing dashboard for 15 minutes.") }
        : null,
  };
}

/** Counts AI calls so tests can prove "no source → no AI call". */
export function countingAnswerer(inner: Answerer = extractiveAnswerer) {
  const calls: string[] = [];
  const answer: Answerer = async (q, s) => {
    calls.push(q);
    return inner(q, s);
  };
  return { answer, calls };
}

export function buildApp(over: Partial<AppDeps> = {}) {
  const deps: AppDeps = {
    config,
    prisma,
    auth: createAuthBackend(config),
    embed: hashEmbedder,
    answer: extractiveAnswerer,
    followUp: simpleFollowUp,
    drive: fakeDrive(),
    mailer: async () => undefined,
    ...over,
  };
  const app = createApp(deps);
  const services = createServices(deps);
  const worker = new Worker(prisma, createHandlers({ ...deps, ...services }), () => undefined);
  return { app, worker, services };
}

export const as = (email: string) => ({ Authorization: `Bearer dev:${email}` });

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    "TRUNCATE questions, chunks, sources, interviews, consent_records, departing_people, users, organizations, jobs, audit_logs RESTART IDENTITY CASCADE",
  );
}

/** Create an organisation with an admin, a reader and a leaving employee who has signed consent. */
export async function setupOrg(app: App, prefix: string, orgName = `${prefix} Ltd`) {
  const admin = `${prefix}-admin@example.com`;
  const reader = `${prefix}-reader@example.com`;
  const leaver = `${prefix}-leaver@example.com`;
  await request(app).post("/api/org").set(as(admin)).send({ name: orgName, yourName: "Ada Admin" }).expect(201);
  await request(app).post("/api/admin/users").set(as(admin)).send({ email: reader, name: "Ray Reader", role: "reader" }).expect(201);
  const person = await request(app).post("/api/admin/people").set(as(admin)).send({ name: "Lee Leaver", email: leaver, role: "Backend engineer", team: "Platform", lastDay: "2026-11-30" }).expect(201);
  await request(app).post("/api/my/consent").set(as(leaver)).send({ typedName: "Lee Leaver", agree: true }).expect(200);
  return { admin, reader, leaver, personId: person.body.id as string };
}

/** Upload a text document as the leaving employee and process it. */
export async function uploadDoc(app: App, worker: Worker, leaver: string, name: string, text: string) {
  const r = await request(app).post("/api/my/sources").set(as(leaver)).attach("file", Buffer.from(text), { filename: name, contentType: "text/plain" }).expect(202);
  await worker.drain();
  return r.body.id as string;
}

/** Answer the whole interview with the given text (long enough to need no follow-up). */
export async function answerAll(app: App, leaver: string, text = "A detailed answer about how the billing service and its nightly reconciliation job really work in production.") {
  // Answer until no question is left (follow-ups and earlier skips change the count).
  for (let i = 0; i < QUESTION_BANK.length * 2; i++) {
    const r = await request(app).post("/api/my/interview/answer").set(as(leaver)).send({ answer: `${text} (${i})` }).expect(200);
    if (!r.body.current) break;
  }
}
