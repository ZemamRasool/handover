// Getting plain text out of uploaded files, and cutting it into small chunks.
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

export type DocType = "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "text/plain" | "text/markdown";

/** What a file really is, from its first bytes (and, for plain text, its name). */
export function sniffDoc(data: Buffer, filename: string): DocType | null {
  if (data.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  // .docx files are ZIP archives that contain word/document.xml
  if (data[0] === 0x50 && data[1] === 0x4b && data.includes(Buffer.from("word/"))) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (data.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, 8192), { stream: true });
  } catch {
    return null;
  }
  return /\.(md|markdown)$/i.test(filename) ? "text/markdown" : "text/plain";
}

export async function extract(data: Buffer, type: DocType): Promise<string> {
  if (type === "application/pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await extractText(pdf, { mergePages: true });
    return String(text);
  }
  if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const { value } = await mammoth.extractRawText({ buffer: data });
    return value;
  }
  return data.toString("utf8");
}

/**
 * Split text into ~900-character chunks on paragraph and sentence boundaries,
 * overlapping a little so a fact cut in half is still found.
 */
export function chunkText(text: string, size = 900, overlap = 150): string[] {
  const clean = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const pieces = clean.split(/(?<=\n\n)|(?<=[.!?])\s+/).filter((p) => p.trim());
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if ((current + " " + piece).length > size && current) {
      chunks.push(current.trim());
      current = current.slice(Math.max(0, current.length - overlap)).replace(/^\S*\s/, "");
    }
    // A single very long piece (no punctuation) is cut hard.
    if (piece.length > size) {
      for (let i = 0; i < piece.length; i += size - overlap) chunks.push(piece.slice(i, i + size).trim());
      current = "";
      continue;
    }
    current += (current ? " " : "") + piece.trim();
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 20 || chunks.length === 1);
}
