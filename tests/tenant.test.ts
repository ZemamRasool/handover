// SPEC.md: "every query must filter by org_id. One company must never see another's data. Add automated tests for this."
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { as, buildApp, prisma, resetDb, setupOrg, uploadDoc } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const SECRET = "The Acme production database password rotation happens every 90 days using the vault-rotate script owned by the platform team.";

async function twoOrgs() {
  const ctx = buildApp();
  const a = await setupOrg(ctx.app, "acme", "Acme");
  const b = await setupOrg(ctx.app, "globex", "Globex");
  const sourceA = await uploadDoc(ctx.app, ctx.worker, a.leaver, "rotation.txt", SECRET);
  return { ...ctx, a, b, sourceA };
}

describe("one organisation can never see another's data", () => {
  it("answers only from the asker's own organisation", async () => {
    const { app, a, b } = await twoOrgs();
    const mine = await request(app).post("/api/ask").set(as(a.reader)).send({ question: "How often is the database password rotated?" }).expect(200);
    expect(mine.body.known).toBe(true);
    const theirs = await request(app).post("/api/ask").set(as(b.reader)).send({ question: "How often is the database password rotated?" }).expect(200);
    expect(theirs.body.known).toBe(false);
    expect(theirs.body.citations).toEqual([]);
    expect(JSON.stringify(theirs.body)).not.toContain("vault-rotate");
  });

  it("filters search by organisation even for identical text", async () => {
    const { worker, b, services, app } = await twoOrgs();
    await uploadDoc(app, worker, b.leaver, "same.txt", SECRET);
    const orgB = (await prisma.user.findUnique({ where: { email: b.admin } }))!.orgId!;
    const hits = await services.knowledge.search(orgB, "password rotation vault-rotate");
    expect(hits.length).toBeGreaterThan(0);
    const chunkOrgs = await prisma.chunk.findMany({ where: { id: { in: hits.map((h) => h.chunkId) } }, select: { orgId: true } });
    expect(new Set(chunkOrgs.map((c) => c.orgId))).toEqual(new Set([orgB]));
  });

  it("hides people, transcripts, sources, questions and audit logs across organisations", async () => {
    const { app, a, b, sourceA } = await twoOrgs();
    await request(app).get(`/api/admin/people/${a.personId}`).set(as(b.admin)).expect(404);
    await request(app).post(`/api/admin/people/${a.personId}/delete-knowledge`).set(as(b.admin)).expect(404);
    await request(app).get(`/api/sources/${sourceA}`).set(as(b.reader)).expect(404);
    await request(app).get(`/api/sources/${sourceA}`).set(as(a.reader)).expect(200);
    expect((await request(app).get("/api/admin/people").set(as(b.admin))).body.map((p: { email: string }) => p.email)).toEqual([b.leaver]);
    expect((await request(app).get("/api/people").set(as(b.reader))).body.map((p: { id: string }) => p.id)).toEqual([b.personId]);

    await request(app).post("/api/ask").set(as(a.reader)).send({ question: "password rotation?" });
    expect((await request(app).get("/api/admin/questions").set(as(b.admin))).body).toEqual([]);
    const audit = (await request(app).get("/api/admin/audit").set(as(b.admin))).body as { actorEmail: string | null }[];
    expect(audit.every((e) => !String(e.actorEmail).startsWith("acme"))).toBe(true);

    const exported = await request(app).get("/api/admin/export").set(as(b.admin)).expect(200);
    expect(JSON.stringify(exported.body)).not.toContain("acme");
    expect(JSON.stringify(exported.body)).not.toContain("vault-rotate");
  });

  it("won't let an admin add someone who belongs to another organisation", async () => {
    const { app, a, b } = await twoOrgs();
    await request(app).post("/api/admin/people").set(as(b.admin)).send({ name: "Lee Leaver", email: a.leaver, role: "Engineer" }).expect(409);
    await request(app).post("/api/admin/users").set(as(b.admin)).send({ email: a.reader, name: "x y", role: "reader" }).expect(409);
  });
});
