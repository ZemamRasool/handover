// Milestone 4: Google Drive, admin dashboard, delete, export, audit.
import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { answerAll, as, buildApp, config, prisma, resetDb, setupOrg, uploadDoc } from "./helpers.js";
import { sign } from "../src/lib/signed.js";
import { loadConfig } from "../src/config.js";

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const stateSecret = createHmac("sha256", config.ENCRYPTION_KEY).update("google-oauth-state").digest("hex");

describe("Google Drive import", () => {
  it("connects with a signed state, stores the token encrypted, and imports chosen files", async () => {
    const { app, worker } = buildApp();
    const o = await setupOrg(app, "acme");
    const me = await request(app).get("/api/me").set(as(o.leaver));
    const forged = await request(app).get("/auth/google/callback").query({ code: "good-code", state: sign(me.body.id, "wrong", 600) });
    expect(forged.headers.location).toContain("drive=failed");

    const ok = await request(app).get("/auth/google/callback").query({ code: "good-code", state: sign(me.body.id, stateSecret, 600) });
    expect(ok.headers.location).toContain("drive=connected");
    const u = await prisma.user.findUnique({ where: { email: o.leaver } });
    expect(u!.googleTokenEnc).not.toContain("refresh-123");

    const files = await request(app).get("/api/my/drive/files").set(as(o.leaver)).expect(200);
    expect(files.body[0].name).toBe("Deploy runbook");
    await request(app).post("/api/my/drive/import").set(as(o.leaver)).send({ fileIds: [files.body[0].id] }).expect(202);
    await request(app).post("/api/my/drive/import").set(as(o.leaver)).send({ fileIds: [files.body[0].id] }).expect(202); // no duplicate
    await worker.drain();
    expect(await prisma.source.count({ where: { type: "google_drive", status: "ready" } })).toBe(1);

    const r = await request(app).post("/api/ask").set(as(o.reader)).send({ question: "How do I deploy the billing service?" });
    expect(r.body.citations[0]).toMatchObject({ type: "google_drive", link: "https://docs.google.com/document/d/doc-runbook-1" });
  });

  it("needs Drive connected first", async () => {
    const { app } = buildApp();
    const o = await setupOrg(app, "acme");
    await request(app).get("/api/my/drive/files").set(as(o.leaver)).expect(412);
  });
});

describe("admin dashboard", () => {
  it("shows progress, the transcript and consent history, and logs that it was viewed", async () => {
    const { app, worker } = buildApp();
    const o = await setupOrg(app, "acme");
    await answerAll(app, o.leaver);
    await uploadDoc(app, worker, o.leaver, "notes.txt", "Vendor contacts: AWS rep is Sam, renewal in March.");
    const ov = await request(app).get("/api/admin/overview").set(as(o.admin)).expect(200);
    expect(ov.body).toMatchObject({ people: 1, consent: { signed: 1 }, interview: { completed: 1 }, documents: 1 });
    const d = await request(app).get(`/api/admin/people/${o.personId}`).set(as(o.admin)).expect(200);
    expect(d.body.progress).toEqual({ answered: 25, total: 25 });
    expect(d.body.consents[0]).toMatchObject({ action: "signed", typedName: "Lee Leaver" });
    expect(await prisma.auditLog.count({ where: { action: "person.view" } })).toBe(1);
  });

  it("deletes a person's knowledge and turns off their access", async () => {
    const { app, worker } = buildApp();
    const o = await setupOrg(app, "acme");
    await uploadDoc(app, worker, o.leaver, "notes.txt", "The staging database is reset every Monday morning by a cron job.");
    await request(app).post(`/api/admin/people/${o.personId}/delete-knowledge`).set(as(o.admin)).expect(200);
    expect(await prisma.chunk.count()).toBe(0);
    await request(app).get("/api/me").set(as(o.leaver)).expect(403);
    const r = await request(app).post("/api/ask").set(as(o.reader)).send({ question: "When is the staging database reset?" });
    expect(r.body.known).toBe(false);
  });

  it("exports everything and deletes the organisation only with its exact name", async () => {
    const { app, worker } = buildApp();
    const o = await setupOrg(app, "acme", "Acme Corp");
    await uploadDoc(app, worker, o.leaver, "notes.txt", "Backups are stored in the eu-west bucket for 30 days.");
    const ex = await request(app).get("/api/admin/export").set(as(o.admin)).expect(200);
    expect(ex.body.sources[0].text).toContain("eu-west bucket");
    expect(ex.body.sources[0]).not.toHaveProperty("fileKey");
    expect(ex.body.consentRecords).toHaveLength(1);
    await request(app).post("/api/admin/org/delete").set(as(o.admin)).send({ confirm: "acme corp" }).expect(400);
    await request(app).post("/api/admin/org/delete").set(as(o.admin)).send({ confirm: "Acme Corp" }).expect(200);
    expect(await prisma.organization.count()).toBe(0);
    expect(await prisma.chunk.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "org.delete" } })).toBe(1);
  });
});

describe("security", () => {
  it("sends strict headers and needs login", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/").expect(200);
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    await request(app).get("/api/me").expect(401);
  });

  it("refuses unsafe production settings", () => {
    const base = { DATABASE_URL: "postgres://x", ENCRYPTION_KEY: "a".repeat(64) };
    expect(() => loadConfig({ ...base, NODE_ENV: "production", AUTH_MODE: "dev" })).toThrow(/AUTH_MODE/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", AUTH_MODE: "firebase" })).toThrow(/VOYAGE_API_KEY/);
    expect(() => loadConfig({ DATABASE_URL: "x", NODE_ENV: "test" })).toThrow(/ENCRYPTION_KEY/);
  });
});
