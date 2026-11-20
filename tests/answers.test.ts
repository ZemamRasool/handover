// Milestones 2–3: documents, chunking, embeddings, search and cited answers.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { as, buildApp, countingAnswerer, prisma, resetDb, setupOrg, uploadDoc } from "./helpers.js";
import { chunkText, extract, sniffDoc } from "../src/services/extract.js";
import { checkAiAnswer, IDK } from "../src/services/ai.js";
import { hashEmbedding } from "../src/services/embeddings.js";

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

const RUNBOOK = `Billing service runbook.

The billing service runs on two servers behind the load balancer. Invoices are generated at 02:00 UTC by the nightly job.

If invoices fail, check the Stripe webhook secret in the ops vault, then rerun the job with: npm run invoices:retry.

Escalation: call Priya in finance first, then the on-call engineer.`;

describe("documents", () => {
  it("recognises file types by content", () => {
    expect(sniffDoc(Buffer.from("%PDF-1.4 ..."), "a.pdf")).toBe("application/pdf");
    expect(sniffDoc(Buffer.from("# Notes"), "notes.md")).toBe("text/markdown");
    expect(sniffDoc(Buffer.from([0x4d, 0x5a, 0, 0x01]), "x.txt")).toBeNull();
  });

  it("reads text out of a real PDF", async () => {
    const pdf = makePdf("Quarterly close checklist for finance");
    expect(await extract(pdf, "application/pdf")).toContain("Quarterly close checklist");
  });

  it("splits long text into overlapping chunks", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about the deployment process.`).join(" ");
    const chunks = chunkText(long, 300, 60);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.length <= 360)).toBe(true);
    expect(chunkText("short note")).toEqual(["short note"]);
  });

  it("stores uploads encrypted and makes them searchable", async () => {
    const { app, worker } = buildApp();
    const o = await setupOrg(app, "acme");
    const id = await uploadDoc(app, worker, o.leaver, "billing-runbook.txt", RUNBOOK);
    const src = await prisma.source.findUnique({ where: { id } });
    expect(src).toMatchObject({ status: "ready", type: "upload" });
    const mine = await request(app).get("/api/my/sources").set(as(o.leaver)).expect(200);
    expect(mine.body[0]).toMatchObject({ title: "billing-runbook.txt", status: "ready" });
  });

  it("marks files with no readable text as failed, and lets the admin see them", async () => {
    const { app, worker } = buildApp();
    const o = await setupOrg(app, "acme");
    await uploadDoc(app, worker, o.leaver, "empty.txt", "   \n  ");
    const failed = await request(app).get("/api/admin/jobs").set(as(o.admin)).expect(200);
    expect(failed.body[0].error).toMatch(/No readable text/);
  });
});

describe("answers with citations", () => {
  it("answers from the right document and shows where it came from", async () => {
    const { app, worker } = buildApp();
    const o = await setupOrg(app, "acme");
    await uploadDoc(app, worker, o.leaver, "billing-runbook.txt", RUNBOOK);
    await uploadDoc(app, worker, o.leaver, "lunch.txt", "The team lunch is on Fridays at the Thai place near the office.");
    const r = await request(app).post("/api/ask").set(as(o.reader)).send({ question: "What do I do when invoices fail?" }).expect(200);
    expect(r.body.known).toBe(true);
    expect(r.body.citations[0]).toMatchObject({ person: "Lee Leaver", type: "upload" });
    expect(r.body.citations[0].title).toContain("billing-runbook");
    expect(r.body.answer).toContain("[1]");
    const full = await request(app).get(`/api/sources/${r.body.citations[0].sourceId}`).set(as(o.reader)).expect(200);
    expect(full.body.text).toContain("invoices:retry");
  });

  it("says I don't know, without calling the AI, when nothing is relevant", async () => {
    const counting = countingAnswerer();
    const { app, worker } = buildApp({ answer: counting.answer });
    const o = await setupOrg(app, "acme");
    await uploadDoc(app, worker, o.leaver, "billing-runbook.txt", RUNBOOK);
    const r = await request(app).post("/api/ask").set(as(o.reader)).send({ question: "What colour is the CEO's car?" }).expect(200);
    expect(r.body).toMatchObject({ known: false, answer: IDK, citations: [] });
    expect(counting.calls).toHaveLength(0);
  });

  it("rejects an AI answer that cites nothing real (no source, no answer)", () => {
    const sources = [{ n: 1, title: "Runbook", person: "Lee", text: "..." }];
    expect(checkAiAnswer({ known: true, answer: "Probably restart it.", citations: [] }, sources)).toMatchObject({ known: false, answer: IDK });
    expect(checkAiAnswer({ known: true, answer: "Restart it [7].", citations: [7] }, sources)).toMatchObject({ known: false });
    expect(checkAiAnswer({ known: true, answer: "Restart it [1].", citations: [1, 1] }, sources)).toMatchObject({ known: true, cited: [1] });
    expect(checkAiAnswer({ nonsense: true }, sources)).toBeNull();
  });

  it("uses the interview answers too", async () => {
    const { app, worker } = buildApp();
    const o = await setupOrg(app, "acme");
    await request(app).post("/api/my/interview/answer").set(as(o.leaver)).send({ answer: "I own the SSL certificates. They renew through certbot on the edge server; the cron runs on Sundays." }).expect(200);
    await worker.drain();
    const r = await request(app).post("/api/ask").set(as(o.reader)).send({ question: "How do the SSL certificates renew?" }).expect(200);
    expect(r.body.known).toBe(true);
    expect(r.body.citations[0].type).toBe("interview");
  });

  it("records ratings so the admin can review bad and unknown answers", async () => {
    const { app, worker } = buildApp();
    const o = await setupOrg(app, "acme");
    await uploadDoc(app, worker, o.leaver, "billing-runbook.txt", RUNBOOK);
    const good = await request(app).post("/api/ask").set(as(o.reader)).send({ question: "Who do I escalate billing problems to?" });
    await request(app).post(`/api/questions/${good.body.id}/rate`).set(as(o.reader)).send({ rating: -1 }).expect(200);
    await request(app).post(`/api/questions/${good.body.id}/rate`).set(as(o.admin)).send({ rating: 1 }).expect(404); // only the asker rates
    await request(app).post("/api/ask").set(as(o.reader)).send({ question: "Where is the coffee machine manual?" });
    const problems = await request(app).get("/api/admin/questions?filter=problems").set(as(o.admin)).expect(200);
    expect(problems.body).toHaveLength(2);
  });

  it("gives similar fingerprints to related text", () => {
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
    const q = hashEmbedding("how do invoices get generated");
    expect(dot(q, hashEmbedding("Invoices are generated by the nightly job"))).toBeGreaterThan(dot(q, hashEmbedding("Team lunch is on Fridays")));
  });
});

/** A tiny valid PDF with one line of text. */
function makePdf(text: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}
