# Project 3: Company Second Brain

**Working name:** Handover

**One-line pitch:** "When someone leaves, their knowledge stays."

**Memorable line:** *Employees leave. Knowledge should not.*

## The problem

When a key employee quits, years of knowledge disappear: why decisions were made, how systems really work, where things are hidden. The next person wastes weeks or months relearning it.

## Important: what this product is and is not

It is **not** secret surveillance. It only works with **company permission and employee consent**, and only on **work material** (documents, tickets, code reviews, chats in work channels). Say this clearly on the first page of the website. This is also the legal and ethical foundation of the business.

## Who pays

Startups and mid-size companies (20 to 500 people) with technical or specialist staff, especially agencies, software companies, and consultancies.

## Business model

- **Subscription:** \$300 to \$1,500 per month per company, or

- **Per departure:** \$299 for a full knowledge capture of one leaving employee.

Start with per departure. It is easy to understand and easy to sell.

## MVP scope (start much smaller than the big vision)

**Version A, the "Exit Interview AI":**

1.  Company admin adds a leaving employee.

2.  The AI interviews that employee in chat, asking about 25 smart questions (what they own, what is fragile, who to call, what is undocumented, what they would fix).

3.  The employee uploads or links key documents.

4.  The system builds a searchable knowledge base for that person.

5.  The next hire asks questions and gets answers **with sources shown**.

**Version B (later):** connect Google Drive, Slack, GitHub, and Notion to enrich the knowledge base automatically.

**Do NOT build yet:** voice cloning, personality imitation, "digital twin that talks like the person", or monitoring of current employees.

## How the answer engine works (RAG)

RAG means Retrieval Augmented Generation. In simple words: **find the right pages first, then let the AI answer using only those pages.**

1.  Split every document and interview answer into small chunks.

2.  Turn each chunk into numbers called an embedding (a meaning fingerprint).

3.  Store them in PostgreSQL with the pgvector extension.

4.  When someone asks a question, find the closest chunks, send only those to the AI model, and ask it to answer **with citations**.

5.  If nothing relevant is found, the AI says "I do not know" instead of guessing.

The most important rule: **no source, no answer.**

## Data model (tables)

- organizations (id, name, plan)

- users (id, org_id, role: admin / employee / reader)

- departing_people (id, org_id, name, role, last_day, consent_status)

- consent_records (id, person_id, signed_at, scope_text)

- sources (id, org_id, person_id, type, link, ingested_at)

- chunks (id, source_id, text, embedding vector, metadata_json)

- interviews (id, person_id, question, answer, created_at)

- questions (id, asker_id, question, answer, citations_json, rating)

## Technical pieces

- **Tenant isolation:** every query must filter by org_id. One company must never see another's data. Add automated tests for this.

- **Interview engine:** a fixed question bank plus AI follow-up questions.

- **Citations:** every answer lists the document or interview answer it came from.

- **Admin controls:** delete a person's knowledge, export all data, and an audit log.

- **Hosting:** use a region that matches the customer's data rules.

## Risks and honest answers

- **Privacy and consent:** the biggest risk. Use signed consent, clear scope, and easy deletion.

- **Wrong answers:** the AI may mix up facts. Use citations, a rating button, and "I do not know" behavior.

- **Long sales cycles:** big companies take months. Start with small companies where the owner decides.

- **Security:** companies will ask about it first. Prepare a one-page security summary.

## Validation test (one week)

1.  Interview **5 founders or managers**: "What happened the last time a key person quit? What did it cost?"

2.  Offer a **manual pilot**: you personally interview a leaving employee (with consent), organize the answers in a document, and charge or ask for a testimonial.

3.  Goal: **2 companies** agree to a pilot and at least 1 pays.

## Milestones

- **Milestone 1 (week 1 to 2):** organizations, admin login, add departing person, consent form, AI interview chat saving answers.

- **Milestone 2 (week 3):** document upload, chunking, embeddings, search.

- **Milestone 3 (week 4):** question page with cited answers and "I do not know" behavior.

- **Milestone 4 (week 5 to 6):** Google Drive connection, admin dashboard, audit log, delete and export.

## Starter prompt for Claude

> I am building Handover: a tool where a company captures the knowledge of a leaving employee (with consent) through an AI interview and uploaded work documents, so the next hire can ask questions and get answers with citations. Read SPEC.md. Use Node.js, Express, PostgreSQL with Prisma and pgvector, and a web front end. Build Milestone 1 only: organizations, admin login, adding a departing person, a consent form, and an AI interview chat that saves answers. Make every database query filter by organization, and add tests proving one organization cannot see another's data. Explain each file in plain language.

## Shared rules for all three

- **Default stack:** Node.js + Express, PostgreSQL (Neon) with Prisma ORM, Firebase Authentication, Docker, and a web front end first (Flutter mobile later, only after people use the web version).

- **MVP (Minimum Viable Product):** the smallest version that proves people want it. Cut every feature that does not help prove that.

- **Payments warning:** Stripe does not open business accounts in Pakistan. Check this in week one. Options: a US company via Stripe Atlas, Paddle or Lemon Squeezy (they act as the seller for you), or Wise and Payoneer for payouts. Do not build payments until this is solved.

- **Security basics:** encrypt secrets, never store passwords yourself, keep one customer's data fully separate from another's, log who accessed what.

- **Legal basics:** write a privacy policy and terms of service before real users arrive. Talk to a lawyer before handling other people's money, emails, or employee data.

