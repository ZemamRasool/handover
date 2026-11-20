// The knowledge base (RAG, SPEC.md "How the answer engine works"):
//   1. split each document / interview answer into chunks
//   2. turn each chunk into an embedding (meaning fingerprint)
//   3. store them in Postgres with pgvector
//   4. for a question: find the closest chunks IN THIS ORGANISATION ONLY, then answer from those
//   5. nothing relevant → "I don't know". No source, no answer.
import { Prisma } from "../generated/prisma/client.js";
import type { Db } from "../lib/prisma.js";
import type { Answerer, SourceSnippet } from "./ai.js";
import { IDK } from "./ai.js";
import { chunkText } from "./extract.js";
import { toVectorLiteral, type Embedder } from "./embeddings.js";

export interface Hit {
  chunkId: string;
  sourceId: string;
  title: string;
  type: string;
  link: string | null;
  person: string;
  text: string;
  similarity: number;
  keyword: number;
  score: number;
}

export class Knowledge {
  constructor(
    private readonly prisma: Db,
    private readonly embed: Embedder,
    private readonly answer: Answerer,
    private readonly minRelevance: number,
  ) {}

  /** Replace a source's chunks with freshly embedded ones and mark it ready. */
  async storeText(sourceId: string, text: string) {
    const source = await this.prisma.source.findUniqueOrThrow({ where: { id: sourceId } });
    const pieces = chunkText(text);
    if (!pieces.length) {
      await this.prisma.source.update({ where: { id: sourceId }, data: { status: "failed", error: "No readable text found in this file." } });
      return 0;
    }
    const vectors = await this.embed(pieces, "document");
    await this.prisma.$transaction(async (db) => {
      await db.chunk.deleteMany({ where: { sourceId } });
      for (let i = 0; i < pieces.length; i++) {
        const id = `${sourceId}_${i}`;
        await db.$executeRaw`
          INSERT INTO chunks (id, org_id, source_id, position, text, embedding, metadata_json, created_at)
          VALUES (${id}, ${source.orgId}, ${sourceId}, ${i}, ${pieces[i]}, ${toVectorLiteral(vectors[i])}::vector,
                  ${JSON.stringify({ title: source.title, type: source.type })}::jsonb, (now() AT TIME ZONE 'UTC'))`;
      }
      await db.source.update({ where: { id: sourceId }, data: { status: "ready", error: null, ingestedAt: new Date() } });
    });
    return pieces.length;
  }

  /**
   * Closest chunks for a question, from people in THIS organisation who consented and whose
   * knowledge hasn't been deleted. Score mixes meaning (embedding) and shared words (keywords:
   * any meaningful word of the question counts; passages sharing more words rank higher).
   */
  async search(orgId: string, question: string, limit = 8): Promise<Hit[]> {
    const [vector] = await this.embed([question], "query");
    const rows = await this.prisma.$queryRaw<
      { chunk_id: string; source_id: string; title: string; type: string; link: string | null; person: string; text: string; similarity: number; keyword: number }[]
    >(Prisma.sql`
      WITH q AS (SELECT ${toVectorLiteral(vector)}::vector AS v, replace(plainto_tsquery('english', ${question.slice(0, 500)})::text, ' & ', ' | ')::tsquery AS t)
      SELECT c.id AS chunk_id, s.id AS source_id, s.title, s.type::text AS type, s.link, p.name AS person, c.text,
             (1 - (c.embedding <=> q.v))::float8 AS similarity,
             -- ts_rank gives a tiny non-zero score even when no word matches, so count it only on a real match
             (CASE WHEN c.search_vector @@ q.t THEN ts_rank(c.search_vector, q.t) ELSE 0 END)::float8 AS keyword
      FROM chunks c
      JOIN sources s ON s.id = c.source_id
      JOIN departing_people p ON p.id = s.person_id
      CROSS JOIN q
      WHERE c.org_id = ${orgId} AND s.org_id = ${orgId} AND p.org_id = ${orgId}
        AND s.status = 'ready' AND p.consent_status = 'signed' AND p.knowledge_deleted_at IS NULL
      ORDER BY (1 - (c.embedding <=> q.v)) + (CASE WHEN c.search_vector @@ q.t THEN LEAST(ts_rank(c.search_vector, q.t) * 5, 0.5) ELSE 0 END) DESC
      LIMIT 40`);
    return rows
      .map((r) => ({
        chunkId: r.chunk_id,
        sourceId: r.source_id,
        title: r.title,
        type: r.type,
        link: r.link,
        person: r.person,
        text: r.text,
        similarity: Number(r.similarity),
        keyword: Number(r.keyword),
        score: Number(r.similarity) + Math.min(Number(r.keyword) * 5, 0.5),
      }))
      .filter((h) => h.similarity >= this.minRelevance || h.keyword > 0)
      .slice(0, limit);
  }

  /** Answer with citations, or "I don't know". Saves the question for the admin's quality review. */
  async ask(orgId: string, askerId: string, question: string) {
    const hits = await this.search(orgId, question);
    const snippets: SourceSnippet[] = hits.map((h, i) => ({ n: i + 1, title: h.title, person: h.person, text: h.text }));
    const result = hits.length ? await this.answer(question, snippets) : { known: false, answer: IDK, cited: [], usedAi: false };
    const citations = result.cited.map((n) => {
      const h = hits[n - 1];
      return { n, sourceId: h.sourceId, title: h.title, type: h.type, person: h.person, link: h.link, snippet: h.text.slice(0, 500) };
    });
    const saved = await this.prisma.question.create({
      data: { orgId, askerId, question, answer: result.answer, known: result.known, citationsJson: citations, usedAi: result.usedAi },
    });
    return { id: saved.id, question, answer: result.answer, known: result.known, citations, createdAt: saved.createdAt };
  }
}
