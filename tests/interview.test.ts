// Milestone 1: consent and the AI interview.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { answerAll, as, buildApp, prisma, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const ADMIN = "boss@acme.com";
const LEAVER = "lee@acme.com";

async function withLeaver(sign = true) {
  const ctx = buildApp();
  await request(ctx.app).post("/api/org").set(as(ADMIN)).send({ name: "Acme", yourName: "Boss" }).expect(201);
  const p = await request(ctx.app).post("/api/admin/people").set(as(ADMIN)).send({ name: "Lee Leaver", email: LEAVER, role: "Head of Ops" }).expect(201);
  if (sign) await request(ctx.app).post("/api/my/consent").set(as(LEAVER)).send({ typedName: "lee leaver", agree: true }).expect(200);
  return { ...ctx, personId: p.body.id as string };
}

describe("consent", () => {
  it("shows exactly what will and won't be collected", async () => {
    const { app } = await withLeaver(false);
    const c = await request(app).get("/api/my/consent").set(as(LEAVER)).expect(200);
    expect(c.body.status).toBe("pending");
    expect(c.body.text).toContain("Lee Leaver");
    expect(c.body.text).toContain("Acme");
    expect(c.body.text).toMatch(/What will NOT be collected/);
    expect(c.body.text).toMatch(/No "digital twin"/);
  });

  it("blocks the interview and uploads until consent is signed", async () => {
    const { app } = await withLeaver(false);
    await request(app).post("/api/my/interview/answer").set(as(LEAVER)).send({ answer: "hello there" }).expect(403);
    await request(app).post("/api/my/sources").set(as(LEAVER)).attach("file", Buffer.from("text"), "a.txt").expect(403);
  });

  it("needs the person's own full name and keeps an unchangeable record", async () => {
    const { app, personId } = await withLeaver(false);
    await request(app).post("/api/my/consent").set(as(LEAVER)).send({ typedName: "Someone Else", agree: true }).expect(400);
    await request(app).post("/api/my/consent").set(as(LEAVER)).send({ typedName: "Lee Leaver", agree: true }).expect(200);
    const rec = await prisma.consentRecord.findMany({ where: { personId } });
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ action: "signed", typedName: "Lee Leaver" });
    expect(rec[0].scopeText).toContain("What will be collected");
  });
});

describe("interview", () => {
  it("asks the first question with the person's role", async () => {
    const { app } = await withLeaver();
    const s = await request(app).get("/api/my/interview").set(as(LEAVER)).expect(200);
    expect(s.body.current.text).toContain("Head of Ops");
    expect(s.body.progress).toEqual({ answered: 0, total: 25 });
  });

  it("asks one follow-up after a thin answer, then moves on", async () => {
    const { app } = await withLeaver();
    const r1 = await request(app).post("/api/my/interview/answer").set(as(LEAVER)).send({ answer: "I do ops stuff" }).expect(200);
    expect(r1.body.current).toMatchObject({ isFollowUp: true, key: "role_summary" });
    const r2 = await request(app).post("/api/my/interview/answer").set(as(LEAVER)).send({ answer: "I run the deploys, on-call rota and the vendor contracts for hosting and email." }).expect(200);
    expect(r2.body.current).toMatchObject({ isFollowUp: false, key: "owned_systems" });
    expect(r2.body.progress.answered).toBe(1);
  });

  it("lets the person skip questions and finishes after 25", async () => {
    const { app } = await withLeaver();
    await request(app).post("/api/my/interview/answer").set(as(LEAVER)).send({ skip: true }).expect(200);
    await answerAll(app, LEAVER);
    const s = await request(app).get("/api/my/interview").set(as(LEAVER)).expect(200);
    expect(s.body.status).toBe("completed");
    expect(s.body.current).toBeNull();
    await request(app).post("/api/my/interview/answer").set(as(LEAVER)).send({ answer: "more" }).expect(409);
  });

  it("turns answers into searchable knowledge, and edits rebuild it", async () => {
    const { app, worker } = await withLeaver();
    await request(app).post("/api/my/interview/answer").set(as(LEAVER)).send({ answer: "I own the nightly invoice export job that runs on the ops server at 2am and emails finance." }).expect(200);
    await worker.drain();
    expect(await prisma.source.count({ where: { type: "interview", status: "ready" } })).toBe(1);
    expect(await prisma.chunk.count()).toBeGreaterThan(0);
    await request(app).put("/api/my/interview/answer").set(as(LEAVER)).send({ key: "role_summary", isFollowUp: false, answer: "Changed: I own the payroll export at 3am." }).expect(200);
    await worker.drain();
    const chunk = await prisma.chunk.findFirst();
    expect(chunk!.text).toContain("payroll export at 3am");
  });

  it("deletes everything when consent is withdrawn", async () => {
    const { app, worker } = await withLeaver();
    await request(app).post("/api/my/interview/answer").set(as(LEAVER)).send({ answer: "The VPN config lives in the ops 1Password vault, entry 'office VPN'." });
    await request(app).post("/api/my/sources").set(as(LEAVER)).attach("file", Buffer.from("Runbook: restart the queue with systemctl restart worker."), "runbook.txt").expect(202);
    await worker.drain();
    expect(await prisma.chunk.count()).toBeGreaterThan(0);
    await request(app).post("/api/my/consent/withdraw").set(as(LEAVER)).expect(200);
    expect(await prisma.chunk.count()).toBe(0);
    expect(await prisma.source.count()).toBe(0);
    expect(await prisma.interviewAnswer.count()).toBe(0);
    expect((await prisma.consentRecord.findMany()).map((r) => r.action)).toEqual(["signed", "withdrawn"]);
    await request(app).post("/api/my/interview/answer").set(as(LEAVER)).send({ answer: "again" }).expect(403);
  });
});
