// Organisations, invitations and who can do what.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { as, buildApp, prisma, resetDb, setupOrg } from "./helpers.js";

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe("organisations and roles", () => {
  it("makes the creator the admin, and blocks people with no organisation", async () => {
    const { app } = buildApp();
    const me = await request(app).get("/api/me").set(as("new@example.com")).expect(200);
    expect(me.body.org).toBeNull();
    await request(app).post("/api/ask").set(as("new@example.com")).send({ question: "anything?" }).expect(403);
    await request(app).post("/api/org").set(as("new@example.com")).send({ name: "Initech", yourName: "Bill L" }).expect(201);
    expect((await request(app).get("/api/me").set(as("new@example.com"))).body).toMatchObject({ role: "admin", org: { name: "Initech" } });
    await request(app).post("/api/org").set(as("new@example.com")).send({ name: "Second", yourName: "Bill L" }).expect(409);
  });

  it("lets invited people join by logging in with their email", async () => {
    const { app } = buildApp();
    const o = await setupOrg(app, "acme");
    const reader = await request(app).get("/api/me").set(as(o.reader)).expect(200);
    expect(reader.body).toMatchObject({ role: "reader", org: { name: "acme Ltd" } });
    const leaver = await request(app).get("/api/me").set(as(o.leaver)).expect(200);
    expect(leaver.body).toMatchObject({ role: "employee", person: { name: "Lee Leaver", consentStatus: "signed" } });
    const invite = await prisma.job.findMany({ where: { type: "send_email" } });
    expect(invite.some((j) => (j.payload as { to: string }).to === o.leaver)).toBe(true);
  });

  it("keeps each role to its own area", async () => {
    const { app } = buildApp();
    const o = await setupOrg(app, "acme");
    await request(app).get("/api/admin/overview").set(as(o.reader)).expect(403);
    await request(app).get("/api/admin/overview").set(as(o.leaver)).expect(403);
    await request(app).post("/api/ask").set(as(o.leaver)).send({ question: "what?" }).expect(403);
    await request(app).get("/api/my/interview").set(as(o.reader)).expect(403);
    await request(app).get("/api/my/interview").set(as(o.admin)).expect(403);
    expect(await prisma.auditLog.count({ where: { action: "access.denied" } })).toBe(5);
  });

  it("lets the admin change roles and turn access off, but not their own", async () => {
    const { app } = buildApp();
    const o = await setupOrg(app, "acme");
    const users = (await request(app).get("/api/admin/users").set(as(o.admin))).body as { id: string; email: string }[];
    const reader = users.find((u) => u.email === o.reader)!;
    const admin = users.find((u) => u.email === o.admin)!;
    await request(app).patch(`/api/admin/users/${admin.id}`).set(as(o.admin)).send({ disabled: true }).expect(400);
    await request(app).patch(`/api/admin/users/${reader.id}`).set(as(o.admin)).send({ disabled: true }).expect(200);
    await request(app).get("/api/me").set(as(o.reader)).expect(403);
  });
});
