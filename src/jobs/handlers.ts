// What each background job does.
//   send_email        — deliver one notification email
//   ingest_source     — read an uploaded / Drive document, chunk it, embed it
//   ingest_interview  — turn one interview answer (+ follow-up) into searchable chunks
import type { Db } from "../lib/prisma.js";
import type { Encryptor } from "../lib/crypto.js";
import type { Mailer } from "../services/mailer.js";
import type { Knowledge } from "../services/knowledge.js";
import type { PeopleService } from "../services/people.js";
import type { FileStorage } from "../services/storage.js";
import type { DriveApi } from "../services/drive.js";
import { extract, sniffDoc, type DocType } from "../services/extract.js";
import { QUESTION_BANK } from "../services/questionBank.js";
import type { Handlers } from "./queue.js";

export interface HandlerDeps {
  prisma: Db;
  crypto: Encryptor;
  mailer: Mailer;
  knowledge: Knowledge;
  people: PeopleService;
  storage: FileStorage;
  drive: DriveApi;
}

export function createHandlers(d: HandlerDeps): Handlers {
  return {
    send_email: async (job) => {
      await d.mailer(job.payload);
    },

    ingest_interview: async (job) => {
      const { personId, questionKey } = job.payload;
      const person = await d.prisma.departingPerson.findUnique({ where: { id: personId } });
      if (!person || person.consentStatus !== "signed" || person.knowledgeDeletedAt) return;
      const text = await d.people.interviewText(personId, questionKey);
      const base = QUESTION_BANK.find((q) => q.key === questionKey);
      let source = await d.prisma.source.findFirst({ where: { personId, type: "interview", link: questionKey } });
      if (!text) {
        if (source) await d.prisma.source.delete({ where: { id: source.id } });
        return;
      }
      source ??= await d.prisma.source.create({
        data: { orgId: person.orgId, personId, type: "interview", title: `Interview: ${base?.section ?? "Answer"} — ${base?.key.replace(/_/g, " ") ?? questionKey}`, link: questionKey },
      });
      await d.knowledge.storeText(source.id, `${person.name} (${person.role}) said in their handover interview:\n\n${text}`);
    },

    ingest_source: async (job) => {
      const source = await d.prisma.source.findUnique({ where: { id: job.payload.sourceId }, include: { person: { include: { user: true } } } });
      if (!source || source.status === "ready") return;
      if (source.person.consentStatus !== "signed" || source.person.knowledgeDeletedAt) return;
      try {
        let data: Buffer;
        let type: DocType | null;
        if (source.type === "google_drive") {
          const token = source.person.user?.googleTokenEnc;
          if (!token || !source.externalId) throw new Error("Google Drive is no longer connected.");
          const got = await d.drive.fetch(d.crypto.decryptText(token), source.externalId);
          if (!got) throw new Error("This Drive file can't be imported.");
          data = got.data;
          type = got.kind === "pdf" ? "application/pdf" : got.kind === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "text/plain";
        } else {
          if (!source.fileKey) throw new Error("The uploaded file is missing.");
          data = await d.storage.read(source.fileKey);
          type = sniffDoc(data, source.title);
        }
        if (!type) throw new Error("Unsupported file type.");
        const text = (await extract(data, type)).trim();
        if (!text) throw new Error("No readable text found in this file.");
        await d.knowledge.storeText(source.id, `${source.title}\n\n${text}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await d.prisma.source.update({ where: { id: source.id }, data: { status: "failed", error: message.slice(0, 300) } });
      }
    },
  };
}
