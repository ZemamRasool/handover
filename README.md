# Handover

**When someone leaves, their knowledge stays.**
*Employees leave. Knowledge should not.*

Before a key employee leaves, Handover captures their **work** knowledge, **with their signed consent**. It runs a one-hour AI interview and takes the work documents they choose to share. The next hire asks questions in plain words and gets answers that **always show their sources**, or "I don't know". Built to `SPEC.md`, Milestones 1–4.

> **This is not surveillance.** It only works with company permission AND employee consent, only on work material the employee chooses, with no monitoring and no "digital twin". This is said on the home page, in the consent form and in the terms.

## What it does

| | |
|---|---|
| **Organisations and roles** | The first user creates the company and becomes **admin**. Admins invite **readers** (the team who ask questions) and add **leaving employees**. Each role sees only its own area, checked on the server. |
| **Consent** (Milestone 1) | The leaving employee is emailed an invitation. They read exactly what is and isn't collected, who sees it and how long it's kept, then sign by typing their full name. Each signature and withdrawal is a new record that is never edited. **Withdrawing deletes everything they shared.** Nothing is collected before they sign. |
| **AI interview** (Milestone 1) | 25 fixed questions in sections: role, how things really work, decisions and history, people, unwritten knowledge, advice for the successor. Short or vague answers get **one AI follow-up** (Gemini). They can skip questions, edit answers, and stop and resume any time. |
| **Documents** (Milestone 2) | Uploads of PDF, Word, text and Markdown, checked by their content and **stored encrypted**. They're split into overlapping chunks, given embeddings (**Voyage AI**) and stored in **PostgreSQL + pgvector**. Interview answers become searchable the same way. |
| **Answers with citations** (Milestone 3) | Search mixes *meaning* (pgvector) with *keywords* (Postgres full-text), **filtered to the asker's organisation**. Gemini answers **only from the passages found**, citing [1], [2]. **No source, no answer:** if nothing relevant is found, the AI isn't even called, and an AI answer without real citations becomes "I don't know". Readers can open the full source and rate answers 👍/👎. |
| **Google Drive** (Milestone 4) | The employee connects their Drive (read-only) and picks the files to share. Google Docs, Sheets, Slides, PDF and Word are supported. Only the selected files are read. |
| **Admin** (Milestone 4) | Progress tiles, the people list with transcript, documents and consent history, delete one person's knowledge, team invites and roles, an **answer-quality** review (unknown and 👎 answers show the gaps), the **audit log**, **export everything**, and **delete the organisation**. |
| **Security page** | `/security` is the one-page security summary that the spec says companies will ask for first. |

## Security
- **Organisations kept apart:** every table with company data carries `org_id`, and every query filters by it, *including the vector search*. **Automated tests prove** that one organisation cannot see, search, export or delete another's people, transcripts, sources, answers or audit log (`tests/tenant.test.ts`).
- **Passwords:** none are stored; login is through Firebase.
- **Encryption:** uploaded files and Google tokens are encrypted with AES-256-GCM. The Google OAuth state is signed and expires after 10 minutes.
- **Audit log:** sign-ins, consent, uploads, Drive imports, every question, every transcript or source view, deletions and exports, plus denied access attempts.
- **Headers:** strict Content Security Policy, no framing, no referrer, HSTS in production.
- **Rate limits:** on the API, on questions and on interview answers, which keeps AI costs bounded.
- **AI safety:** documents are treated as data, not instructions. Answers are checked, and citations must point to passages that were actually supplied.
- **Production checks:** the server refuses dev login, non-https, a missing AI or embeddings key, or console email in production.

---

## Run it on your computer

You need **Node 22** and **Docker Desktop**.

```bash
cd handover
copy .env.example .env           # Mac/Linux: cp .env.example .env
npm install
npm run gen:key                  # paste into .env as ENCRYPTION_KEY=...
docker compose up -d db          # Postgres 16 with pgvector
npx prisma generate
npx prisma migrate deploy
npm run dev                      # http://localhost:3000
```

Put your keys in `.env`:
- `GEMINI_API_KEY`: for AI follow-ups and written answers. Without it, answers quote the matching passages instead.
- `VOYAGE_API_KEY`: for search by meaning. Without it, search matches words only.

**Try the full flow** (`AUTH_MODE=dev` lets you log in as any email, so use different browser windows):
1. Go to `/app` as `you@acme.com`, create the company, then add a leaving employee (People) and invite a reader (Team).
2. Log in as the leaving employee: read and sign the consent, answer a few interview questions, and upload a runbook under Documents.
3. Log in as the reader and ask a question under Ask. You get an answer with sources. Ask something unrelated and you get "I don't know".
4. As the admin, open the person to see the transcript, the consent record and the audit log.

Invitation emails are printed in the terminal while `MAIL_PROVIDER=console`.

### Tests
```bash
docker compose exec db createdb -U handover handover_test
docker compose exec db psql -U handover -d handover_test -c "CREATE EXTENSION IF NOT EXISTS vector"
```
PowerShell:
```powershell
$env:DATABASE_URL="postgresql://handover:handover@localhost:5432/handover_test"; npx prisma migrate deploy
Remove-Item Env:DATABASE_URL
npm test
```
34 tests cover:
- separation between organisations, and roles
- consent, including withdrawal deleting everything
- the interview: follow-ups, skips, edits, finishing
- documents: reading a real PDF, chunking, empty files
- cited answers, "I don't know" without calling the AI, and the no-source-no-answer check
- ratings, Google Drive, the admin dashboard, deleting knowledge, exporting, deleting the organisation, and security settings

The AI, embeddings and Drive are faked or local in tests, so they cost nothing.

---

## Going live
1. **Login:** set up Firebase the same way as in RefundRadar's README, then set `AUTH_MODE=firebase`.
2. **AI keys:** set `GEMINI_API_KEY` and `VOYAGE_API_KEY`.
3. **Email:** set up Postmark (`MAIL_PROVIDER=postmark`) so invitations arrive.
4. **Google Drive:**
   - In Google Cloud, create an OAuth client and enable the Drive API.
   - The `drive.readonly` scope is "restricted", so Google requires an app verification (security assessment) before the public can use it. Until then, add your pilot users as *test users*.
   - A lighter option for later is the `drive.file` scope with the Google Picker.
5. **Hosting:** put the database in the region your customers need. Use a managed Postgres with pgvector (Neon and Supabase both have it), set `NODE_ENV=production` and an https URL, and **back up** the `ENCRYPTION_KEY`.
6. **Legal (SPEC.md: the biggest risk):** have a lawyer review the consent text (`src/services/people.ts`), the terms and the privacy page. Employee data rules differ by country. Remove the draft notices after the review.
7. **Payments:** the spec says not to build payments until the Pakistan route is decided. Bill the $299 per departure by invoice for now. The admin tiles show how many departures each company captured.

## Validation test (SPEC.md, do this alongside)
Interview 5 founders or managers: "What happened the last time a key person quit?" Offer a **manual pilot**: run the interview yourself with this tool, with consent. Goal: 2 companies agree to a pilot and at least 1 pays.

---

## What each file does

| File | In simple words |
|---|---|
| `SPEC.md` | The product plan. |
| `prisma/schema.prisma` | Tables: organizations, users, departing_people, consent_records, sources, chunks (with the `vector(1024)` embedding), interviews, questions, jobs, audit_logs. |
| `prisma/migrations/` | The SQL that creates them, including pgvector and the search indexes. |
| `src/config.ts` | Settings, and the production safety checks. |
| `src/bootstrap.ts`, `server.ts`, `worker.ts` | Connects the real services; starts the website; runs background jobs. |
| `src/app.ts` | Security headers, rate limits, login and role checks, routes. |
| `src/middleware/requireAuth.ts` | Login, organisation and role checks; claims invitations. |
| `src/services/people.ts` | The consent text, signing and withdrawal, the interview flow, deleting knowledge. |
| `src/services/questionBank.ts` | The 25 interview questions. |
| `src/services/ai.ts` | Gemini follow-ups and cited answers, the "no source, no answer" check, and the no-AI fallbacks. |
| `src/services/embeddings.ts` | Voyage embeddings, and the local fallback. |
| `src/services/extract.ts` | File-type check, PDF and Word reading, chunking. |
| `src/services/knowledge.ts` | Storing chunks, searching (organisation-filtered), answering. |
| `src/services/drive.ts` | Google Drive connection, listing and file download. |
| `src/services/storage.ts` | Encrypted file storage. |
| `src/services/mailer.ts` | Email. |
| `src/jobs/` | Background jobs: email, document ingest, interview ingest. |
| `src/routes/team.ts` | Me, create organisation, ask, questions, people directory, source view. |
| `src/routes/employee.ts` | Consent, interview, documents and Drive for the leaving employee. |
| `src/routes/admin.ts` | Admin: overview, people, team, answer quality, audit, export, delete. |
| `public/index.html` | Home page, including the "not surveillance" promise and pricing. |
| `public/app.html` + `js/app.js` | The app, adapting to the role: admin, reader or leaving employee. |
| `public/security.html`, `terms.html`, `privacy.html` | Security summary and draft legal pages. |
| `tests/` | 34 automatic tests. |

## Known limits
- **Without a Voyage key:** search matches words, not meaning, so "deploy" won't find "release". Set the key for real use.
- **Scanned PDFs (images only):** these have no text to read. OCR isn't built in.
- **Slack, GitHub and Notion connectors:** left out, as the spec says ("Version B, later").
- **Left out on purpose:** voice cloning, personality imitation and monitoring of current employees. The spec says never to build these.
