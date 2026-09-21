# Development plan — Product Career OS

From chat artifact to a working application, and from there to something other people could use.
Phase 1 is built and tested; phases 2–5 are the plan.

---

## 1. Why the artifact version could not work

Worth stating precisely, because it determines the whole architecture.

A chat artifact renders inside a sandboxed iframe. It has no API key, no server, and no credentials
it could safely hold — if it did hold a key, that key would be visible to anyone who opened the page.
So `fetch('https://api.anthropic.com/...')` from inside an artifact fails before the request leaves
the browser. That is not a bug in the code; it is the security boundary working as designed.

**The rule this establishes:** any feature that needs a secret, a real database, or heavy processing
(PDF parsing, long documents) belongs on a server. The browser gets rendering and interaction only.

Everything below follows from that.

---

## 2. Architecture

```
Browser (public/index.html)
  │  single-page UI: plan, cases, studio, portfolio, interview, coach
  │  no secrets, no model calls, no parsing
  ▼  HTTP/JSON
Node + Express server (server.js)
  ├── /api/state      GET, PUT     document store, autosaved
  ├── /api/upload     POST         PDF / DOCX / MD / TXT → plain text
  ├── /api/ai/review  POST         rubric-scored artifact review  → strict JSON
  ├── /api/ai/chat    POST         coach conversation
  ├── /api/ai/hook    POST         LinkedIn post generation
  ├── /api/export     GET          full backup
  ├── /api/snapshots  GET, POST    hourly restore points
  └── /api/health,/api/usage       status and cost telemetry
       │                    │
       ▼                    ▼
  SQLite (data/career.db)   Anthropic API (key from .env, server-side only)
    state · snapshots · files · ai_log
```

**Stack choices and why.** Express and SQLite because this is a single-user app that must run on a
laptop with no infrastructure and no monthly bill; SQLite in WAL mode handles this workload with
room to spare and is one file to back up. Vanilla JS on the front end because the UI is already
written and works, and a framework would add a build step for no user-visible gain. Every dependency is pure JS
and the database driver is Node's built-in `node:sqlite`, so `npm install` never compiles anything —
a clean-install check caught `better-sqlite3` failing to build and it was removed for that reason
(it remains an optional fallback for Node older than 22.5).

**Why the model call is server-side even though it feels like a detour:** the key stays secret, the
prompt and rubric stay under version control instead of being editable in the browser, JSON repair
and retry logic live in one place, and every call gets logged for cost tracking.

---

## 3. Phase 1 — shipped and tested

| Area | Status |
|---|---|
| 52-week curriculum, 12 cases, 13 rubrics, interview bank | done |
| Artifact review on Claude Opus, six scored dimensions, fixes, rewrite | done |
| PDF and DOCX upload with server-side text extraction | done |
| SQLite persistence, hourly snapshots, restore, export | done |
| Coach chat, LinkedIn post generation, portfolio, pipeline | done |
| Graceful degradation when the server or key is absent | done |
| Automated tests: 26 API + 25 end-to-end UI = 51 assertions | passing |

Two real bugs were found by those tests and fixed before shipping: `pdf-parse` v2 changed its export
shape (a class, not a function), and mock-mode calls were skipping the usage log.

**Known limits of phase 1:** single user, no auth, HTTP on localhost, no rate limiting, review is
one-shot with no revision history, and the state document is written whole on each save rather than
diffed. All are acceptable for one person on one machine; none are acceptable beyond that.

---

## 4. Phase 2 — depth for a single user (2–3 weeks, ~20 hours)

The goal is to make the review loop compound rather than repeat.

1. **Artifact versioning.** Store every revision, not just the latest. `artifact_versions(artifact_id,
   n, content, review_json, created)`. Then a diff view showing which dimension scores moved between
   v1 and v2. This is the single highest-value addition — it turns the app into a record of
   improvement rather than a pile of one-off scores.
2. **Review conversation.** Let a review be argued with: "you scored framing 2, but the constraint
   was fixed" → the coach responds and can revise. Needs the review to persist as a message thread,
   not a static JSON blob.
3. **Streaming responses.** A 1,200-word review takes 20–40 seconds. Stream it token by token
   (`client.messages.stream`) over SSE so the page fills in as it generates.
4. **Weekly digest.** A cron-style job producing a Monday email or dashboard card: what shipped,
   what slipped, score trend, the specific artifact to fix this week.
5. **Full-text search** across artifacts, reviews and case answers, using SQLite FTS5.

## 5. Phase 3 — hosted and multi-user (3–4 weeks)

Only worth doing if other people are going to use it.

1. **Postgres instead of SQLite,** with a `users` table and every row keyed by `user_id`. Migration
   is mechanical: the schema is small and the state document maps to a JSONB column.
2. **Auth.** Magic-link email or Google OAuth. Sessions in httpOnly cookies. No password storage.
3. **Per-user key handling.** Either each user supplies their own Anthropic key (encrypted at rest,
   simplest liability position) or you meter usage centrally and charge for it. Decide this before
   building, because it changes the billing model.
4. **Rate limiting and abuse control** on every AI route — token budget per user per day.
5. **Deploy.** Railway or Render for the server plus a managed Postgres; Fly.io if you want a volume
   and to keep SQLite. Vercel is a poor fit here because of the long-running model calls.
6. **Observability.** Structured logs, error tracking (Sentry), an admin view over `ai_log`.

## 6. Phase 4 — product features that justify other people paying (4–6 weeks)

1. **Curriculum as data, not code.** Move the 52 weeks into the database with an editor, so a coach
   can author tracks (Growth PM, AI PM, first-time PM) without touching source.
2. **Cohorts.** Shared plan, visible progress, peer review of artifacts. Peer review is the feature
   that makes this social rather than a solo tool.
3. **Public portfolio pages.** One-click publish an artifact to a clean public URL with your name on
   it — the thing you actually send to a hiring manager.
4. **JD-targeted review.** Paste a job description; the rubric weights shift toward what that role
   screens for, and the review names the specific gap against that JD.
5. **Mock interview mode.** Voice or text, multi-turn, with the model playing a hiring manager who
   interrupts and probes — a much harder and more useful drill than single-answer grading.

## 7. Phase 5 — if it becomes a business

Analytics on what actually correlates with offers, integrations (Calendar for study blocks, LinkedIn
for publishing, ATS trackers), a coach console for reviewing mentee artifacts at scale, and mobile.
None of this matters until phases 2 and 3 have real users on them.

---

## 8. Data model

Current (SQLite):

```sql
state      (id=1, doc TEXT, updated)          -- whole app state as JSON
snapshots  (id, doc TEXT, created)            -- hourly restore points, 50 kept
files      (id, name, mime, bytes, text, created)
ai_log     (id, kind, model, in_tok, out_tok, ms, ok, created)
```

Phase 3 target (Postgres): `users`, `profiles`, `weeks`, `artifacts`, `artifact_versions`,
`reviews`, `cases`, `case_answers`, `applications`, `interviews`, `chat_messages`, `files`,
`ai_log` — all keyed by `user_id`, with the JSON document split into proper relations once
multiple users and queries across them exist.

---

## 9. Cost

The app logs `input_tokens` and `output_tokens` for every call at `/api/usage`, so real spend is
measurable rather than guessed. Rough volumes per call:

| Call | Input | Output |
|---|---|---|
| Artifact review (1,200-word artifact) | ~2,000 tokens | ~700 tokens |
| Resume review (PDF-extracted) | ~1,200 tokens | ~700 tokens |
| Case grading | ~2,500 tokens | ~700 tokens |
| Coach message | ~1,500 tokens | ~300 tokens |

At the plan's intended pace — roughly one artifact review, one case, and a handful of coach messages
per week — that is well under 100k tokens a month. Multiply by current published rates at
anthropic.com/pricing for the model you set in `.env`; Opus costs materially more than Sonnet, so a
sensible optimisation is Opus for reviews (where judgment quality matters) and Sonnet for chat.
That routing is a two-line change in `server.js`.

---

## 10. Security

Already handled: the key is server-side and never sent to the browser; uploads are capped at 20 MB
and restricted by extension; state writes are type-checked before they touch the database; all user
content is HTML-escaped on render.

Needed before hosting: HTTPS, auth, per-user data isolation, rate limits, encrypted key storage if
you hold user keys, and a privacy note explaining that artifact text is sent to Anthropic for review.

---

## 11. Suggested sequence

Do not build phase 2 yet. Use phase 1 for four weeks first — through weeks 1–4 of the curriculum and
at least three real artifact reviews. That will tell you which of the phase 2 items you actually
want, and it will be a different list from the one above. The most common outcome is that versioning
and streaming matter and everything else can wait.

If after four weeks you are still using it, build versioning and streaming, then reassess. Only go to
phase 3 when a second person asks for access.
