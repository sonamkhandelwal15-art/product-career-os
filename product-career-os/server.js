/* Product Career OS — application server
   Node + Express + SQLite. Holds your Anthropic key server-side and does the work
   the browser sandbox cannot: model calls, file parsing, durable storage, backups. */
import express from 'express';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const mammoth = require('mammoth');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* Load .env from beside this file (not the shell's working directory, which varies). */
const ENV_PATH = path.join(__dirname, '.env');
let ENV_LOADED = false, ENV_DUPES = [];
if (fs.existsSync(ENV_PATH)) {
  try {
    const found = {};
    for (const raw of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '').trim();
      if (!/^[A-Z0-9_]+$/i.test(k)) continue;
      if (k in found && found[k] !== v) ENV_DUPES.push(k);
      found[k] = v;                              // a later line wins, as people expect when editing
    }
    for (const [k, v] of Object.entries(found)) if (!process.env[k]) process.env[k] = v;
    ENV_LOADED = Object.keys(found).length > 0;
  } catch (e) { console.error('  .env found but could not be read: ' + e.message); }
}

const PORT = process.env.PORT || 3311;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const MOCK = process.env.MOCK_AI === '1';
const KEY = process.env.ANTHROPIC_API_KEY || '';
const WORKSPACE = (process.env.ANTHROPIC_WORKSPACE_ID || '').trim();   // only needed for org-scoped keys
const BASE_URL = process.env.ANTHROPIC_BASE_URL || undefined;           // override for tests

/* ---------------- storage ---------------- */
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
// SQLite: prefer Node's built-in driver (no native build), fall back to better-sqlite3 if present.
let db;
try {
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(path.join(DATA, 'career.db'));
} catch {
  const { default: Database } = await import('better-sqlite3');
  db = new Database(path.join(DATA, 'career.db'));
}
try { db.exec('PRAGMA journal_mode = WAL'); } catch { }
db.exec(`
  CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id=1), doc TEXT NOT NULL, updated INTEGER);
  CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, doc TEXT NOT NULL, created INTEGER);
  CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT, mime TEXT, bytes INTEGER, text TEXT, created INTEGER);
  CREATE TABLE IF NOT EXISTS ai_log (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, model TEXT, in_tok INTEGER, out_tok INTEGER, ms INTEGER, ok INTEGER, created INTEGER);
`);
const getState = () => { const r = db.prepare('SELECT doc FROM state WHERE id=1').get(); return r ? JSON.parse(r.doc) : null; };
const putState = (doc) => {
  const s = JSON.stringify(doc);
  db.prepare('INSERT INTO state (id,doc,updated) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc, updated=excluded.updated').run(s, Date.now());
  const last = db.prepare('SELECT created FROM snapshots ORDER BY id DESC LIMIT 1').get();
  if (!last || Date.now() - last.created > 36e5) {           // hourly snapshot, keep 50
    db.prepare('INSERT INTO snapshots (doc,created) VALUES (?,?)').run(s, Date.now());
    db.exec('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 50)');
  }
};

/* ---------------- model ---------------- */
const client = KEY ? new Anthropic({
  apiKey: KEY,
  ...(BASE_URL ? { baseURL: BASE_URL } : {}),
  ...(WORKSPACE ? { defaultHeaders: { 'anthropic-workspace-id': WORKSPACE } } : {})
}) : null;

/* Turn Anthropic's API errors into something actionable rather than a raw dump. */
function explain(err) {
  const raw = (err && (err.message || '')) + ' ' + JSON.stringify(err?.error || err?.response?.data || {});
  if (/anthropic-workspace-id/i.test(raw)) return {
    code: 'workspace_required',
    message: 'Your API key is scoped to the organisation, not a workspace. Either create a workspace-scoped key in console.anthropic.com (Settings \u2192 Workspaces \u2192 pick a workspace \u2192 API Keys), or add ANTHROPIC_WORKSPACE_ID=wrkspc_... to .env and restart.'
  };
  if (/credit balance|insufficient|quota/i.test(raw)) return {
    code: 'no_credit',
    message: 'The API account has no credit. Add a balance under Billing at console.anthropic.com. This is separate from a Claude subscription.'
  };
  if (/invalid x-api-key|authentication|401/i.test(raw)) return {
    code: 'bad_key',
    message: 'The API key was rejected. Check for a stray space or a truncated paste in .env, or create a fresh key.'
  };
  if (/model/i.test(raw) && /not_found|does not exist|invalid/i.test(raw)) return {
    code: 'bad_model',
    message: `The model id "${MODEL}" was rejected. Set ANTHROPIC_MODEL in .env to a current id (for example claude-sonnet-5) and restart.`
  };
  if (/rate_limit|429/i.test(raw)) return { code: 'rate_limited', message: 'Rate limited by the API. Wait a minute and try again.' };
  if (/overloaded|529/i.test(raw)) return { code: 'overloaded', message: 'The API is temporarily overloaded. Try again shortly.' };
  return { code: 'api_error', message: (err && err.message ? err.message : 'Unknown API error').slice(0, 400) };
}
const MOCK_REVIEW = {
  level: 'At bar', headline: 'Mock response — set ANTHROPIC_API_KEY to get a real review.',
  scores: [{ dim: 'Problem framing', score: 4, why: 'mock' }, { dim: 'Insight quality', score: 3, why: 'mock' }],
  strengths: ['mock strength'], fixes: [{ issue: 'mock issue', how: 'mock fix' }],
  rewrite: '"was involved in" → "I owned"', next: 'mock next action'
};

async function ask({ system, messages, kind = 'generic', maxTokens = 2000 }) {
  const t0 = Date.now();
  if (MOCK) {
    db.prepare('INSERT INTO ai_log (kind,model,in_tok,out_tok,ms,ok,created) VALUES (?,?,0,0,?,1,?)').run(kind, 'mock', Date.now() - t0, Date.now());
    return { text: kind === 'review' ? JSON.stringify(MOCK_REVIEW) : 'Mock reply from the coach.', usage: {} };
  }
  if (!client) { const e = new Error('no_key'); e.code = 'no_key'; throw e; }
  try {
    const r = await client.messages.create({ model: MODEL, max_tokens: maxTokens, system, messages });
    const text = (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    db.prepare('INSERT INTO ai_log (kind,model,in_tok,out_tok,ms,ok,created) VALUES (?,?,?,?,?,1,?)')
      .run(kind, MODEL, r.usage?.input_tokens ?? 0, r.usage?.output_tokens ?? 0, Date.now() - t0, Date.now());
    return { text, usage: r.usage };
  } catch (err) {
    db.prepare('INSERT INTO ai_log (kind,model,in_tok,out_tok,ms,ok,created) VALUES (?,?,0,0,?,0,?)')
      .run(kind, MODEL, Date.now() - t0, Date.now());
    throw err;
  }
}
function parseJSON(text) {
  let c = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = c.indexOf('{'), b = c.lastIndexOf('}');
  if (a >= 0 && b > a) c = c.slice(a, b + 1);
  return JSON.parse(c);
}
const coachSystem = (p = {}) => `You are a hiring VP of Product with 20+ years building and staffing product teams in India and globally. You review work the way a hiring panel does: specific, unsentimental, useful. You never flatter. You name the exact passage that is weak and rewrite it to show the standard. Calibrate to the Senior PM bar at a Series B/C company in ${p.city || 'Bengaluru'}.

CANDIDATE CONTEXT: ${p.context || 'not supplied'}
TARGET ROLE: ${p.role || 'Senior Product Manager'}`;

/* ---------------- app ---------------- */
const app = express();
app.disable('x-powered-by');

/* ---------------- access gate ----------------
   Locally: open. Deployed: set APP_PASSWORD and every page and API route
   requires it (HTTP Basic auth — the browser shows a login prompt).
   In production the server refuses to start without one, because an open
   deployment lets anyone with the URL spend your API credit. */
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const APP_USER = (process.env.APP_USER || 'sonam').trim();
if (process.env.NODE_ENV === 'production' && !APP_PASSWORD) {
  console.error('\n  Refusing to start: NODE_ENV=production but APP_PASSWORD is not set.');
  console.error('  Set APP_PASSWORD in your host\u2019s environment settings, then redeploy.\n');
  process.exit(1);
}
app.get('/healthz', (_q, res) => res.json({ ok: true }));        // for the host's health checks
if (APP_PASSWORD) {
  const { timingSafeEqual } = await import('crypto');
  const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
  app.use((req, res, next) => {
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) {
      const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
      if (same(u, APP_USER) && same(rest.join(':'), APP_PASSWORD)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Product Career OS", charset="UTF-8"');
    res.status(401).send('Authentication required');
  });
}
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.get('/api/health', (_q, res) => res.json({
  ok: true, ai: MOCK ? 'mock' : (KEY ? 'live' : 'no_key'), model: MODEL, workspace: WORKSPACE ? 'set' : 'not set',
  artifacts: (getState()?.artifacts || []).length,
  calls: db.prepare('SELECT COUNT(*) c FROM ai_log').get().c
}));

app.get('/api/state', (_q, res) => res.json(getState()));
app.put('/api/state', (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'bad body' });
  putState(req.body); res.json({ saved: true, at: Date.now() });
});

/* file → text. This is the piece the browser sandbox could never do. */
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ error: 'no file' });
  let text = '';
  try {
    const n = f.originalname.toLowerCase();
    if (n.endsWith('.pdf')) {
      const { PDFParse } = require('pdf-parse');          // v2 exposes a class, not a default fn
      const parser = new PDFParse({ data: new Uint8Array(f.buffer) });
      try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
    } else if (n.endsWith('.docx')) {
      text = (await mammoth.extractRawText({ buffer: f.buffer })).value;
    } else if (/\.(txt|md|csv|json|html?)$/.test(n)) {
      text = f.buffer.toString('utf8');
    } else {
      return res.status(415).json({ error: 'unsupported type', hint: 'pdf, docx, txt, md, csv, json, html' });
    }
  } catch (e) { return res.status(422).json({ error: 'could not read file: ' + e.message }); }
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  const id = Math.random().toString(36).slice(2, 10);
  db.prepare('INSERT INTO files (id,name,mime,bytes,text,created) VALUES (?,?,?,?,?,?)')
    .run(id, f.originalname, f.mimetype, f.size, text, Date.now());
  res.json({ id, name: f.originalname, chars: text.length, words: text.split(/\s+/).filter(Boolean).length, text });
});

app.post('/api/ai/review', async (req, res) => {
  const { type = 'strategy', label = 'Artifact', dims = [], title = '', content = '', profile = {} } = req.body || {};
  if (!content.trim()) return res.status(400).json({ error: 'empty content' });
  const system = coachSystem(profile) + `

You are grading an artifact of type: ${label}. Score each dimension 1-5 (3 = competent mid-level PM, 4 = clears the Senior PM bar, 5 = would be shown to a VP as an exemplar). Be strict; most first drafts sit at 2-3.
Return ONLY valid JSON, no prose, no fences:
{"level":"Below bar|At bar|Senior bar","headline":"one blunt sentence","scores":[{"dim":"...","score":0,"why":"one sentence citing something specific from their work"}],"strengths":["..."],"fixes":[{"issue":"...","how":"..."}],"rewrite":"quote one weak passage from their work, then rewrite it to the standard","next":"single highest-leverage next action"}
Dimensions, in this order: ${dims.join(', ')}. fixes: 3-4 items. strengths: 2-3 items. Keep every field terse.`;
  try {
    let out = await ask({ system, kind: 'review', messages: [{ role: 'user', content: `TITLE: ${title}\n\n${content.slice(0, 120000)}` }] });
    let json;
    try { json = parseJSON(out.text); }
    catch { // one repair attempt before giving up
      out = await ask({ system, kind: 'review_retry', messages: [{ role: 'user', content: `TITLE: ${title}\n\n${content.slice(0, 60000)}` }, { role: 'assistant', content: out.text }, { role: 'user', content: 'Return only the JSON object. No other text.' }] });
      json = parseJSON(out.text);
    }
    if (!Array.isArray(json.scores) || !json.scores.length) throw new Error('malformed scores');
    json.scoreAvg = +(json.scores.reduce((a, b) => a + (+b.score || 0), 0) / json.scores.length).toFixed(1);
    json.src = 'Claude ' + (MOCK ? 'mock' : MODEL);
    res.json(json);
  } catch (e) {
    if (e.code === 'no_key') return res.status(503).json({ error: 'no_key' });
    const x = explain(e); res.status(502).json({ error: x.message, code: x.code });
  }
});

app.post('/api/ai/chat', async (req, res) => {
  const { messages = [], profile = {}, week = '' } = req.body || {};
  try {
    const out = await ask({
      system: coachSystem(profile) + `\nCurrent week of the 52-week plan: ${week}. Answer in under 250 words unless asked for more. Be direct. Push back when the plan is wrong; do not validate for the sake of it.`,
      kind: 'chat', maxTokens: 1200,
      messages: messages.slice(-12).map(m => ({ role: m.r === 'u' ? 'user' : 'assistant', content: m.c }))
    });
    res.json({ text: out.text });
  } catch (e) {
    if (e.code === 'no_key') return res.status(503).json({ error: 'no_key' });
    const x = explain(e); res.status(502).json({ error: x.message, code: x.code });
  }
});

app.post('/api/ai/hook', async (req, res) => {
  const { title = '', content = '', profile = {} } = req.body || {};
  try {
    const out = await ask({
      system: coachSystem(profile), kind: 'hook', maxTokens: 800,
      messages: [{ role: 'user', content: `Write a LinkedIn post for this artifact. 120-180 words. Open with a specific claim or number, not a hook cliche. No emojis, no "excited to share", max 2 hashtags. Practitioner voice with a point of view. End with a question that invites disagreement.\n\nARTIFACT: ${title}\n\n${content.slice(0, 20000)}` }]
    });
    res.json({ text: out.text });
  } catch (e) {
    if (e.code === 'no_key') return res.status(503).json({ error: 'no_key' });
    const x = explain(e); res.status(502).json({ error: x.message, code: x.code });
  }
});

app.get('/api/export', (_q, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="career-os-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ state: getState(), files: db.prepare('SELECT id,name,bytes,created FROM files').all(), exported: Date.now() });
});
app.get('/api/snapshots', (_q, res) => res.json(db.prepare('SELECT id,created FROM snapshots ORDER BY id DESC').all()));
app.post('/api/snapshots/:id/restore', (req, res) => {
  const s = db.prepare('SELECT doc FROM snapshots WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  putState(JSON.parse(s.doc)); res.json({ restored: true });
});
app.get('/api/usage', (_q, res) => res.json(db.prepare(
  'SELECT kind, COUNT(*) calls, SUM(in_tok) in_tok, SUM(out_tok) out_tok, AVG(ms) avg_ms, SUM(ok) ok FROM ai_log GROUP BY kind').all()));

app.listen(PORT, () => {
  console.log(`\n  Product Career OS  →  http://localhost:${PORT}`);
  if (KEY) console.log(`  model: ${MODEL}   key: loaded from ${ENV_LOADED ? '.env' : 'environment'} (…${KEY.slice(-4)})   workspace: ${WORKSPACE || 'not set (only needed for org-scoped keys)'}`);
  if (ENV_DUPES.length) console.log(`  ! .env defines ${[...new Set(ENV_DUPES)].join(', ')} more than once — the LAST line is used. Delete the older lines.`);
  if (KEY) console.log('  If a call fails, run:  npm run doctor');
  else if (MOCK) console.log(`  model: ${MODEL}   MOCK MODE — canned responses, no key needed`);
  else {
    console.log(`  model: ${MODEL}   key: MISSING`);
    console.log(fs.existsSync(ENV_PATH)
      ? `  → ${ENV_PATH} exists but has no usable ANTHROPIC_API_KEY line.\n    It must read exactly:  ANTHROPIC_API_KEY=sk-ant-...  (no quotes, no spaces around =)`
      : `  → No .env file at ${ENV_PATH}\n    Create it there (note: Notepad may save it as .env.txt — use "All Files" in Save As).`);
  }
  console.log(`  data: ${DATA}\n`);
});
