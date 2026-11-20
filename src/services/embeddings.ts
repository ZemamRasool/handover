// Embeddings: turn text into 1024 numbers (a "meaning fingerprint") so we can find
// text that means the same thing, even with different words. SPEC.md "How the answer engine works".
//
// Real: Voyage AI.
// Fallback: a keyword fingerprint made locally (feature hashing). Free and private, but it
// only matches shared words, not meaning. Keyword search runs alongside either way.
import { createHash } from "node:crypto";

export const DIMENSIONS = 1024;
export type Embedder = (texts: string[], kind: "document" | "query") => Promise<number[][]>;

export function createVoyageEmbedder(apiKey: string, model: string): Embedder {
  return async (texts, kind) => {
    const out: number[][] = [];
    // The API takes batches; 64 short chunks at a time keeps each request small.
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: batch, model, input_type: kind, output_dimension: DIMENSIONS }),
      });
      if (!res.ok) throw new Error(`Voyage error ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      for (const d of data.data.sort((a, b) => a.index - b.index)) out.push(d.embedding);
    }
    return out;
  };
}

const STOP = new Set("a an and are as at be but by for from has have i if in into is it its of on or that the their there this to was we were what when where which who will with you your our us".split(" "));

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, "") || w);
}

/** Local fallback: each word (and pair of words) adds weight to a hashed position. */
export function hashEmbedding(text: string): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  const t = tokens(text);
  const add = (s: string, w: number) => {
    const h = createHash("sha1").update(s).digest();
    const idx = h.readUInt32BE(0) % DIMENSIONS;
    v[idx] += h[4] & 1 ? w : -w;
  };
  t.forEach((w, i) => {
    add(w, 1);
    if (i > 0) add(`${t[i - 1]} ${w}`, 0.5);
  });
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export const hashEmbedder: Embedder = async (texts) => texts.map(hashEmbedding);

/** pgvector's text form: "[0.1,0.2,…]". */
export const toVectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}]`;
