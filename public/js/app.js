// Handover app. What you see depends on your role:
//   admin    → Ask, People, Team, Answer quality, Audit, Settings
//   reader   → Ask, People
//   employee → Consent, Interview, Documents (only your own)
import { api, el, initAuth, message, signOut } from "./auth.js";

const $ = (id) => document.getElementById(id);
let me = null;

const TABS = {
  admin: [["ask", "Ask"], ["people", "People"], ["team", "Team"], ["quality", "Answer quality"], ["audit", "Audit log"], ["settings", "Settings"]],
  reader: [["ask", "Ask"], ["people", "People"]],
  employee: [["consent", "1. Consent"], ["interview", "2. Interview"], ["documents", "3. Documents"]],
};

function show(view) {
  for (const v of ["login", "org", "app"]) $(`${v}-view`).classList.toggle("hidden", v !== view);
  $("logout").classList.toggle("hidden", view === "login");
}

function flash(text, ok = true) {
  message($("flash"), text, ok);
  if (text) setTimeout(() => message($("flash"), ""), 6000);
}

function btn(label, kind, fn, attrs = {}) {
  const b = el("button", { class: `btn ${kind}`, type: "button", ...attrs }, label);
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await fn();
    } catch (err) {
      flash(err.message, false);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

const date = (d) => (d ? new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—");
const when = (d) => (d ? new Date(d).toLocaleString() : "—");
const field = (label, input) => el("label", { class: "field" }, el("span", {}, label), input);
const panel = (...children) => $("panel").replaceChildren(...children);

// ---------------- start & tabs ----------------
async function start() {
  try {
    me = await api("/api/me");
  } catch {
    return;
  }
  $("who").textContent = `${me.name || me.email}${me.org ? ` · ${me.org.name}` : ""}`;
  if (!me.org) return show("org");
  show("app");
  const tabs = TABS[me.role];
  $("tabs").replaceChildren(...tabs.map(([key, label]) => el("button", { class: "tab", "data-tab": key, onclick: () => (location.hash = key) }, label)));
  openTab();
}

function openTab() {
  if (!me?.org) return;
  const tabs = TABS[me.role];
  const name = location.hash.slice(1).split("?")[0];
  const key = tabs.some(([k]) => k === name) ? name : tabs[0][0];
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === key));
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  if (q.get("drive") === "connected") flash("Google Drive connected. Pick the work files to share below.");
  if (q.get("drive") === "failed") flash("Google Drive connection didn't complete. Please try again.", false);
  VIEWS[key]().catch((err) => flash(err.message, false));
}
window.addEventListener("hashchange", openTab);

$("org-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("/api/org", { method: "POST", body: { name: f.name.value, yourName: f.yourName.value, dataRegion: f.dataRegion.value } });
    location.hash = "people";
    start();
  } catch (err) {
    message($("org-msg"), err.message, false);
  }
});

// ---------------- Ask (admin, reader) ----------------
function answerCard(a) {
  const cites = el(
    "div",
    { class: "cites" },
    a.citations.map((c) =>
      el(
        "details",
        { class: "cite" },
        el("summary", {}, `[${c.n}] ${c.title}`, el("span", { class: "muted small" }, ` · from ${c.person}`)),
        el("div", { class: "snippet" }, c.snippet),
        el("div", { class: "row" }, btn("Read the whole source", "btn-ghost btn-sm", () => openSource(c.sourceId)), c.link ? el("a", { class: "btn btn-ghost btn-sm", href: c.link, target: "_blank", rel: "noopener" }, "Open original") : ""),
      ),
    ),
  );
  const rate = el("div", { class: "row" });
  if (a.id) {
    const set = (v) => async () => {
      await api(`/api/questions/${a.id}/rate`, { method: "POST", body: { rating: v } });
      rate.replaceChildren(el("span", { class: "muted small" }, v > 0 ? "Thanks — marked helpful." : "Thanks — the admin will review this answer."));
    };
    if (a.rating) rate.append(el("span", { class: "muted small" }, a.rating > 0 ? "You marked this helpful." : "You marked this as wrong."));
    else rate.append(el("span", { class: "muted small" }, "Was this right?"), btn("👍 Yes", "btn-ghost btn-sm", set(1)), btn("👎 No", "btn-ghost btn-sm", set(-1)));
  }
  return el("div", { class: "card stack" }, el("div", { class: "strong" }, a.question), el("div", { class: `answer ${a.known ? "" : "unknown"}` }, a.answer), a.citations.length ? cites : "", rate);
}

async function openSource(id) {
  const s = await api(`/api/sources/${id}`);
  const dlg = el("dialog", { class: "card" });
  dlg.append(el("div", { class: "card-head" }, el("h2", {}, s.title), btn("Close", "btn-ghost", async () => dlg.close())), el("p", { class: "muted small" }, `From ${s.person.name} (${s.person.role})`), el("div", { class: "consent-text" }, s.text));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

async function viewAsk() {
  const input = el("textarea", { rows: "2", placeholder: "Ask anything about the work of people who left. e.g. How do we deploy the billing service?" });
  const out = el("div", { class: "stack" });
  const ask = async () => {
    if (!input.value.trim()) return;
    out.prepend(el("p", { class: "muted" }, "Searching…"));
    try {
      const a = await api("/api/ask", { method: "POST", body: { question: input.value } });
      out.firstChild.remove();
      out.prepend(answerCard(a));
      input.value = "";
    } catch (err) {
      out.firstChild.remove();
      flash(err.message, false);
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  });
  const history = await api("/api/questions");
  for (const q of history) out.append(answerCard(q));
  panel(
    el("div", { class: "card stack" }, el("h2", {}, "Ask the team's captured knowledge"), el("p", { class: "muted small" }, "Answers come only from interviews and documents shared by people who left, and always show their source. If nothing matches, Handover says it doesn't know."), input, el("div", { class: "row" }, btn("Ask", "btn-primary", ask))),
    el("h3", { class: "group-title" }, history.length ? "Your questions" : ""),
    out,
  );
  input.focus();
}

// ---------------- People ----------------
async function viewPeople() {
  if (me.role !== "admin") {
    const list = await api("/api/people");
    return panel(
      el("div", { class: "card" }, el("h2", {}, "Whose knowledge is available"), list.length ? el("table", {}, el("thead", {}, el("tr", {}, ...["Name", "Role", "Team", "Last day", "Interview", "Documents"].map((h) => el("th", {}, h)))), el("tbody", {}, list.map((p) => el("tr", {}, el("td", {}, p.name), el("td", {}, p.role), el("td", {}, p.team || "—"), el("td", {}, date(p.lastDay)), el("td", {}, el("span", { class: `pill ${p.interviewStatus}` }, p.interviewStatus.replace("_", " "))), el("td", { class: "num-cell" }, String(p.sources)))))) : el("p", { class: "muted" }, "Nobody yet.")),
    );
  }
  const [ov, list] = await Promise.all([api("/api/admin/overview"), api("/api/admin/people")]);
  const tile = (label, value, sub) => el("div", { class: "card tile" }, el("div", { class: "muted small" }, label), el("div", { class: "big" }, value), sub ? el("div", { class: "muted small" }, sub) : "");
  const f = el(
    "form",
    { class: "stack" },
    el("div", { class: "app-grid" }, field("Full name", el("input", { name: "name", required: true })), field("Work email", el("input", { name: "email", type: "email", required: true }))),
    el("div", { class: "app-grid" }, field("Job title", el("input", { name: "role", required: true, placeholder: "e.g. Senior backend engineer" })), field("Team (optional)", el("input", { name: "team" }))),
    field("Last day (optional)", el("input", { name: "lastDay", type: "date" })),
    el("button", { class: "btn btn-primary", type: "submit" }, "Add and send invitation"),
  );
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/admin/people", { method: "POST", body: { name: f.name.value, email: f.email.value, role: f.role.value, team: f.team.value || undefined, lastDay: f.lastDay.value || undefined } });
      flash(`Invitation sent to ${f.email.value}. Nothing is collected until they sign consent.`);
      viewPeople();
    } catch (err) {
      flash(err.message, false);
    }
  });
  panel(
    el(
      "div",
      { class: "tiles" },
      tile("Leaving employees", String(ov.people), `${ov.consent.signed || 0} consented · ${ov.consent.pending || 0} waiting`),
      tile("Interviews done", String(ov.interview.completed || 0), `${ov.interview.in_progress || 0} in progress`),
      tile("Documents", String(ov.documents), `${ov.chunks} searchable passages`),
      tile("Questions asked", String(ov.questions), `${ov.unknownAnswers} unknown · ${ov.badAnswers} marked wrong`),
    ),
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Leaving employees"),
      list.length
        ? el(
            "div",
            { class: "scroll-x" },
            el(
              "table",
              {},
              el("thead", {}, el("tr", {}, ...["Name", "Role", "Last day", "Consent", "Interview", "Docs", ""].map((h) => el("th", {}, h)))),
              el("tbody", {}, list.map((p) => el("tr", {}, el("td", {}, p.name, el("div", { class: "muted small" }, p.email)), el("td", {}, p.role), el("td", {}, date(p.lastDay)), el("td", {}, el("span", { class: `pill ${p.knowledgeDeleted ? "deleted" : p.consentStatus}` }, p.knowledgeDeleted ? "deleted" : p.consentStatus)), el("td", {}, el("span", { class: `pill ${p.interviewStatus}` }, p.interviewStatus.replace("_", " "))), el("td", { class: "num-cell" }, String(p.sources)), el("td", {}, btn("Open", "btn-ghost btn-sm", () => personDetail(p.id)))))),
            ),
          )
        : el("p", { class: "muted" }, "Nobody added yet. Add someone below."),
    ),
    el("div", { class: "card stack" }, el("h2", {}, "Add a leaving employee"), el("p", { class: "muted small" }, "They'll get an email explaining what is collected. Nothing happens until they read and sign the consent."), f),
  );
}

async function personDetail(id) {
  const p = await api(`/api/admin/people/${id}`);
  panel(
    el("div", { class: "row" }, btn("← Back", "btn-ghost", viewPeople)),
    el(
      "div",
      { class: "card stack" },
      el("div", { class: "card-head" }, el("div", {}, el("h2", {}, p.name), el("div", { class: "muted small" }, `${p.role}${p.team ? ` · ${p.team}` : ""} · ${p.email} · last day ${date(p.lastDay)}`)), el("span", { class: `pill ${p.consentStatus}` }, p.consentStatus)),
      el("div", { class: "progress" }, el("div", {})),
      el("p", { class: "small" }, `Interview: ${p.progress.answered} of ${p.progress.total} questions`),
      p.knowledgeDeletedAt
        ? el("p", { class: "msg bad" }, `Knowledge deleted on ${date(p.knowledgeDeletedAt)}.`)
        : btn("Delete this person's knowledge", "btn-danger", async () => {
            if (!confirm(`Delete everything captured from ${p.name}? This can't be undone. Their access is turned off.`)) return;
            await api(`/api/admin/people/${p.id}/delete-knowledge`, { method: "POST" });
            flash("Deleted.");
            personDetail(p.id);
          }),
    ),
    el("div", { class: "card" }, el("h2", {}, "Interview transcript"), p.transcript.length ? el("div", { class: "chat" }, p.transcript.flatMap((t) => [el("div", { class: "bubble q" }, el("small", {}, t.isFollowUp ? "Follow-up" : "Question"), t.question), el("div", { class: `bubble a ${t.skipped ? "skip" : ""}` }, t.skipped ? "Skipped" : t.answer ?? "Not answered yet")])) : el("p", { class: "muted" }, "Not started.")),
    el("div", { class: "card" }, el("h2", {}, "Documents"), p.sources.filter((s) => s.type !== "interview").length ? el("table", {}, el("tbody", {}, p.sources.filter((s) => s.type !== "interview").map((s) => el("tr", {}, el("td", {}, s.title), el("td", {}, s.type.replace("_", " ")), el("td", {}, el("span", { class: `pill ${s.status}` }, s.status), s.error ? el("div", { class: "err" }, s.error) : ""), el("td", { class: "num-cell" }, `${s.chunks} passages`))))) : el("p", { class: "muted" }, "None.")),
    el("div", { class: "card" }, el("h2", {}, "Consent history"), p.consents.length ? el("div", { class: "stack" }, p.consents.map((c) => el("details", {}, el("summary", {}, `${c.action === "signed" ? "Signed" : "Withdrawn"} by "${c.typedName}" on ${when(c.signedAt)} (version ${c.version})`), el("div", { class: "consent-text" }, c.scopeText)))) : el("p", { class: "muted" }, "Not signed yet.")),
  );
  // progress bar width (CSP blocks inline style attributes, so set it from script)
  const bar = document.querySelector(".progress > div");
  if (bar) bar.style.width = `${Math.round((p.progress.answered / p.progress.total) * 100)}%`;
}

// ---------------- Team (admin) ----------------
async function viewTeam() {
  const users = await api("/api/admin/users");
  const f = el("form", { class: "row" }, el("input", { name: "name", placeholder: "Name", required: true }), el("input", { name: "email", type: "email", placeholder: "Email", required: true }), el("select", { name: "role" }, el("option", { value: "reader" }, "Reader (asks questions)"), el("option", { value: "admin" }, "Admin")), el("button", { class: "btn btn-primary", type: "submit" }, "Invite"));
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/admin/users", { method: "POST", body: { name: f.name.value, email: f.email.value, role: f.role.value } });
      flash(`Invitation sent to ${f.email.value}.`);
      viewTeam();
    } catch (err) {
      flash(err.message, false);
    }
  });
  panel(
    el("div", { class: "card stack" }, el("h2", {}, "Invite your team"), el("p", { class: "muted small" }, "Readers can ask questions. Admins can also add leaving employees, delete knowledge and export data."), f),
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Members"),
      el(
        "table",
        {},
        el("thead", {}, el("tr", {}, ...["Name", "Email", "Role", "Status", ""].map((h) => el("th", {}, h)))),
        el(
          "tbody",
          {},
          users.map((u) =>
            el(
              "tr",
              {},
              el("td", {}, u.name || "—"),
              el("td", {}, u.email),
              el("td", {}, u.role),
              el("td", {}, u.disabled ? "access off" : u.joined ? "active" : "invited"),
              el(
                "td",
                { class: "row" },
                u.id === me.id || u.role === "employee"
                  ? ""
                  : [
                      btn(u.role === "admin" ? "Make reader" : "Make admin", "btn-ghost btn-sm", async () => { await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { role: u.role === "admin" ? "reader" : "admin" } }); viewTeam(); }),
                      btn(u.disabled ? "Turn access on" : "Turn access off", "btn-ghost btn-sm", async () => { await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { disabled: !u.disabled } }); viewTeam(); }),
                    ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

// ---------------- Answer quality, audit, settings (admin) ----------------
async function viewQuality() {
  const rows = await api("/api/admin/questions?filter=problems");
  panel(
    el("div", { class: "card stack" }, el("h2", {}, "Answers to check"), el("p", { class: "muted small" }, "Questions Handover couldn't answer, and answers someone marked wrong. Gaps here are good topics for the next interview or document."), rows.length ? el("div", { class: "stack" }, rows.map((q) => el("div", { class: "card stack" }, el("div", { class: "row" }, el("span", { class: "strong" }, q.question), el("span", { class: "badge" }, q.known ? "marked wrong" : "unknown")), el("div", { class: "answer small" }, q.answer), el("div", { class: "muted small" }, `${q.asker} · ${when(q.createdAt)}`)))) : el("p", { class: "muted" }, "Nothing to review.")),
  );
}

async function viewAudit() {
  const rows = await api("/api/admin/audit?limit=200");
  panel(el("div", { class: "card" }, el("h2", {}, "Who did what"), el("div", { class: "scroll-x audit" }, el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "When"), el("th", {}, "Who"), el("th", {}, "Action"))), el("tbody", {}, rows.map((a) => el("tr", {}, el("td", { class: "small" }, when(a.createdAt)), el("td", { class: "small" }, a.actorEmail || "system"), el("td", { class: "small" }, a.action, a.targetType ? ` · ${a.targetType}` : ""))))))));
}

async function viewSettings() {
  panel(
    el("div", { class: "card stack" }, el("h2", {}, me.org.name), el("p", { class: "muted" }, `Plan: ${me.org.plan === "per_departure" ? "$299 per departure" : me.org.plan} · Data region: ${me.org.dataRegion.toUpperCase()}`)),
    el(
      "div",
      { class: "card stack" },
      el("h2", {}, "Your data"),
      el("p", { class: "muted small" }, "Download everything (people, consent records, interviews, documents' text, questions) as one file, or delete the whole organisation."),
      el(
        "div",
        { class: "row" },
        btn("Export all data", "btn-ghost", async () => {
          const data = await api("/api/admin/export");
          const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
          const a = el("a", { href: url, download: "handover-export.json" });
          document.body.append(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        }),
        btn("Delete organisation", "btn-danger", async () => {
          const typed = prompt(`This deletes ${me.org.name} and ALL its data for good. Type the organisation name to confirm.`);
          if (!typed) return;
          await api("/api/admin/org/delete", { method: "POST", body: { confirm: typed } });
          await signOut();
        }),
      ),
    ),
  );
}

// ---------------- Employee: consent, interview, documents ----------------
async function viewConsent() {
  const c = await api("/api/my/consent");
  const body = el("div", { class: "card stack" }, el("h2", {}, `Hi ${c.person.name}`), el("p", {}, `${c.person.org} would like to capture your work knowledge before you leave, so the next person isn't starting from zero. Please read exactly what that means. It's your choice.`), el("div", { class: "consent-text" }, c.text));
  if (c.status === "signed") {
    body.append(
      el("p", { class: "msg ok" }, "You signed this consent. Thank you!"),
      el("div", { class: "row" }, el("a", { class: "btn btn-primary", href: "#interview" }, "Go to the interview →"), btn("Withdraw consent and delete everything", "btn-danger", async () => {
        if (!confirm("Withdraw consent? Everything you shared (interview answers and documents) is deleted. This can't be undone.")) return;
        await api("/api/my/consent/withdraw", { method: "POST" });
        flash("Consent withdrawn. Everything you shared has been deleted.");
        viewConsent();
      })),
    );
  } else if (c.status === "withdrawn") {
    body.append(el("p", { class: "msg bad" }, "You withdrew consent. Everything you shared was deleted. Nothing more will be collected."));
  } else {
    const name = el("input", { placeholder: `Type your full name: ${c.person.name}` });
    const agree = el("input", { type: "checkbox" });
    body.append(
      el("label", { class: "check" }, agree, el("span", {}, "I have read this and I agree.")),
      field("Signature", name),
      btn("Sign and continue", "btn-primary", async () => {
        if (!agree.checked) return flash("Tick the box to agree, or simply close this page if you don't.", false);
        await api("/api/my/consent", { method: "POST", body: { typedName: name.value, agree: true } });
        location.hash = "interview";
      }),
      el("p", { class: "muted small" }, "If you don't agree, just close this page. Nothing will be collected."),
    );
  }
  panel(body);
}

async function viewInterview() {
  const s = await api("/api/my/interview");
  if (s.consent !== "signed") return panel(el("div", { class: "card empty" }, el("h2", {}, "First, the consent"), el("p", { class: "muted" }, "Please read and sign the consent before the interview."), el("a", { class: "btn btn-primary", href: "#consent" }, "Read the consent")));
  const pct = Math.round((s.progress.answered / s.progress.total) * 100);
  const bar = el("div", {});
  const chat = el("div", { class: "chat" }, s.history.flatMap((h) => [el("div", { class: "bubble q" }, el("small", {}, h.isFollowUp ? "Follow-up" : "Question"), h.question), el("div", { class: `bubble a ${h.skipped ? "skip" : ""}` }, h.skipped ? "Skipped" : h.answer ?? "")]));
  const box = el("div", { class: "card stack" });
  if (s.current) {
    const ta = el("textarea", { rows: "6", placeholder: "Write as much or as little as you like. Bullet points are fine. Never include passwords." });
    const send = async (skip) => {
      if (!skip && !ta.value.trim()) return;
      await api("/api/my/interview/answer", { method: "POST", body: skip ? { skip: true } : { answer: ta.value } });
      viewInterview();
    };
    box.append(
      el("div", { class: "muted small" }, s.current.isFollowUp ? "One quick follow-up" : s.current.section),
      el("div", { class: "current-q" }, s.current.text),
      ta,
      el("div", { class: "row" }, btn("Save answer", "btn-primary", () => send(false)), btn("Skip this question", "btn-ghost", () => send(true))),
      el("p", { class: "muted small" }, "Your answers are saved as you go. You can stop and come back any time."),
    );
  } else {
    box.append(el("h2", {}, "Interview complete — thank you!"), el("p", {}, "If you have runbooks, notes or docs that would help, add them under Documents."), el("a", { class: "btn btn-primary", href: "#documents" }, "Add documents →"));
  }
  panel(el("div", { class: "card stack" }, el("div", { class: "card-head" }, el("h2", {}, "Handover interview"), el("span", { class: "muted small" }, `${s.progress.answered} of ${s.progress.total}`)), el("div", { class: "progress" }, bar)), box, s.history.length ? el("div", { class: "card" }, el("h3", { class: "group-title" }, "Your answers so far"), chat) : "");
  bar.style.width = `${pct}%`;
  chat.scrollTop = chat.scrollHeight;
  box.querySelector("textarea")?.focus();
}

async function viewDocuments() {
  const [docs, consent] = await Promise.all([api("/api/my/sources"), api("/api/my/consent")]);
  if (consent.status !== "signed") return panel(el("div", { class: "card empty" }, el("h2", {}, "First, the consent"), el("a", { class: "btn btn-primary", href: "#consent" }, "Read the consent")));
  const file = el("input", { type: "file", accept: ".pdf,.docx,.txt,.md" });
  file.addEventListener("change", async () => {
    const form = new FormData();
    form.append("file", file.files[0]);
    try {
      await api("/api/my/sources", { method: "POST", body: form });
      flash("Uploaded. It's being processed.");
      setTimeout(viewDocuments, 1500);
    } catch (err) {
      flash(err.message, false);
    }
  });
  const driveBox = el("div", { class: "stack" });
  if (!me.driveEnabled) driveBox.append(el("p", { class: "muted small" }, "Google Drive import isn't set up on this server."));
  else if (!me.driveConnected) driveBox.append(el("p", { class: "muted small" }, "Connect your Drive (read-only), then pick the work files to share. Nothing else is read."), btn("Connect Google Drive", "btn-ghost", async () => { const r = await api("/api/my/drive/connect"); location.href = r.url; }));
  else {
    const q = el("input", { type: "search", placeholder: "Search your Drive" });
    const list = el("div", { class: "stack" });
    const load = async () => {
      const files = await api(`/api/my/drive/files?q=${encodeURIComponent(q.value)}`);
      list.replaceChildren(...files.map((f) => el("label", { class: "check" }, el("input", { type: "checkbox", value: f.id }), el("span", {}, f.name, el("span", { class: "muted small" }, ` · ${date(f.modifiedTime)}`)))));
    };
    q.addEventListener("change", load);
    driveBox.append(el("div", { class: "row" }, q, btn("Search", "btn-ghost", load)), list, el("div", { class: "row" }, btn("Import selected files", "btn-primary", async () => {
      const ids = [...list.querySelectorAll("input:checked")].map((c) => c.value);
      if (!ids.length) return;
      await api("/api/my/drive/import", { method: "POST", body: { fileIds: ids } });
      flash(`Importing ${ids.length} file(s).`);
      setTimeout(viewDocuments, 1500);
    }), btn("Disconnect Drive", "btn-ghost", async () => { await api("/api/my/drive", { method: "DELETE" }); me.driveConnected = false; viewDocuments(); })));
    load().catch((err) => flash(err.message, false));
  }
  panel(
    el(
      "div",
      { class: "app-grid" },
      el("div", { class: "card stack" }, el("h2", {}, "Upload work documents"), el("p", { class: "muted small" }, "Runbooks, notes, how-tos, specs. PDF, Word, text or Markdown. Only work material, please."), el("label", { class: "drop" }, file, el("span", {}, "Choose a file"))),
      el("div", { class: "card stack" }, el("h2", {}, "From Google Drive"), driveBox),
    ),
    el(
      "div",
      { class: "card" },
      el("h2", {}, "What you've shared"),
      docs.length
        ? el("table", {}, el("tbody", {}, docs.map((d) => el("tr", {}, el("td", {}, d.title), el("td", {}, d.type.replace("_", " ")), el("td", {}, el("span", { class: `pill ${d.status}` }, d.status), d.error ? el("div", { class: "err" }, d.error) : ""), el("td", {}, btn("Remove", "btn-ghost btn-sm", async () => { await api(`/api/my/sources/${d.id}`, { method: "DELETE" }); viewDocuments(); }))))))
        : el("p", { class: "muted" }, "Nothing yet."),
    ),
  );
  if (docs.some((d) => d.status === "processing")) setTimeout(() => location.hash.startsWith("#documents") && viewDocuments(), 3000);
}

const VIEWS = { ask: viewAsk, people: viewPeople, team: viewTeam, quality: viewQuality, audit: viewAudit, settings: viewSettings, consent: viewConsent, interview: viewInterview, documents: viewDocuments };

$("logout").addEventListener("click", () => signOut());
initAuth({
  form: $("login-form"),
  googleBtn: $("google-btn"),
  hint: $("login-hint"),
  say: (t, ok) => message($("login-msg"), t, ok),
  onSignedIn: start,
  onSignedOut: () => show("login"),
});
