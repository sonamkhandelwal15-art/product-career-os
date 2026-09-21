# Product Career OS

A 52-week product career build, run as a web app: weekly curriculum with sourced material, a case
vault in mobility / D2C / lifecycle / AI, artifact review against senior-PM hiring rubrics on Claude,
portfolio tracking, interview drills, and a coach.

Node + Express + SQLite. One server process, one database file, your own Anthropic key.

```
public/index.html   the whole UI — no build step
server.js           API, storage, model calls, file parsing, access gate
doctor.js           diagnoses any model-call failure in one command
test/               6 suites, 98 assertions, no API key needed
docs/               development plan and roadmap
Dockerfile          production image
render.yaml         one-click Render deploy with a persistent disk
```

---

## 1. Run it locally

Needs **Node 22.5+** (`node -v`) and an Anthropic API key from console.anthropic.com.

```bash
npm install
cp .env.example .env          # Windows: copy .env.example .env
# edit .env, set ANTHROPIC_API_KEY
npm start                     # → http://localhost:3311
```

No key yet? `npm run mock` runs every AI feature with canned responses.

If a review fails, run `npm run doctor`. It inspects `.env` with your key masked, makes one tiny real
API call, and names the exact problem and fix.

---

## 2. Push to GitHub

Create an **empty private** repository on github.com (no README, no .gitignore — this repo has
both). Then, from this folder:

```bash
git init
git add .
git commit -m "Product Career OS v1"
git branch -M main
git remote add origin https://github.com/<your-username>/product-career-os.git
git push -u origin main
```

**Before pushing, check that no secret is staged:**

```bash
git status
```

You must **not** see `.env` or `data/` in the list. The `.gitignore` excludes both, but confirm it —
a pushed API key is compromised the moment it lands, even in a private repo, and must be revoked.

Every push runs the test suite on GitHub Actions (`.github/workflows/test.yml`). A green tick on the
commit means all six suites passed.

---

## 3. Deploy

A deployed instance needs three things a laptop does not: a **password**, a **persistent disk**, and
your key set in the host's **environment settings** rather than a file.

### Option A — Render (config is in the repo)

1. render.com → **New + → Blueprint** → connect GitHub → pick this repo.
2. Render reads `render.yaml` and prompts for the two secrets:
   `ANTHROPIC_API_KEY` and `APP_PASSWORD` (pick a long passphrase).
3. Deploy. Open the URL; your browser asks for a username and password —
   username `sonam`, password as set.

The blueprint attaches a 1 GB disk at `/data`. That disk is what keeps your artifacts across
redeploys. Render offers disks only on paid instances; on the free tier, every redeploy or restart
wipes the database. Check current plans on Render's pricing page before choosing.

### Option B — Railway

1. railway.app → **New Project → Deploy from GitHub repo** → pick this repo.
   Railway detects the `Dockerfile` automatically.
2. **Variables** tab: add `ANTHROPIC_API_KEY`, `APP_PASSWORD`, `NODE_ENV=production`,
   `DATA_DIR=/data`.
3. **Settings → Volumes → New Volume**, mount path `/data`.
4. **Settings → Networking → Generate Domain.**

### Any Docker host

```bash
docker build -t career-os .
docker run -p 3311:3311 -v career-data:/data \
  -e ANTHROPIC_API_KEY=sk-ant-... -e APP_PASSWORD=your-passphrase career-os
```

### If you use an org-scoped key

Add `ANTHROPIC_WORKSPACE_ID=wrkspc_...` to the host's variables. Better: create a key from inside a
workspace (console → Settings → Workspaces → open one → its API Keys tab) and skip this.

---

## 4. Security, briefly

- **The password gate is mandatory in production.** With `NODE_ENV=production` and no
  `APP_PASSWORD`, the server refuses to start. An open URL lets anyone spend your API credit.
- Every page and API route sits behind the gate except `/healthz`, which returns `{"ok":true}`
  and nothing else, so the host can check the service is alive.
- The API key stays server-side and is never sent to the browser.
- Uploads are capped at 20 MB and restricted to pdf, docx, txt, md, csv, json, html.
- Basic auth is appropriate for a single-user app over HTTPS, which both hosts provide by default.
  For more than one user, see `docs/DEVELOPMENT-PLAN.md` phase 3 — real accounts and per-user data.

---

## 5. Data and backups

Everything lives in `career.db` inside `DATA_DIR` (`./data` locally, `/data` deployed).

| Route | What it does |
|---|---|
| `GET /api/export` | full JSON backup (the Export button) |
| `GET /api/snapshots` | automatic hourly snapshots, last 50 kept |
| `POST /api/snapshots/:id/restore` | roll back to one |
| `GET /api/usage` | model calls, token totals and latency by type |

Moving from laptop to a deployed instance: Export locally, then Import in the deployed app
(Setup & Data).

---

## 6. Tests

```bash
npm test
```

| Suite | Checks |
|---|---|
| `env.test.js` | `.env` loading from any folder, quotes, CRLF, duplicates |
| `auth.test.js` | gate on/off, wrong credentials, production refusal, open health check |
| `workspace.test.js` | workspace header actually sent; API errors translated to plain guidance |
| `doctor.test.js` | every failure mode the diagnostic can name |
| `api.test.js` | storage, real PDF/DOCX extraction, model endpoints, snapshots, restart survival |
| `ui.test.js` | the real UI over real HTTP against the real server, end to end |

All run against a mock or local fake API, so they cost nothing and need no key.

---

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Cannot find package 'express'` | `npm install` not run in this folder |
| `key: MISSING` at startup | no `.env` beside `server.js`, or Windows saved it as `.env.txt` |
| review mentions `anthropic-workspace-id` | org-scoped key; see §3 |
| any other review failure | `npm run doctor` |
| deployed site loses data on redeploy | no persistent disk attached at `DATA_DIR` |
| deployed site won't start | `APP_PASSWORD` not set in production |
| `npm doctor` prints npm version warnings | that is npm's own tool; you want `npm run doctor` |
