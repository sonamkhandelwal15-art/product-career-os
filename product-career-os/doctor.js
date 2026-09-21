/* npm run doctor — finds out exactly why a model call is failing.
   Inspects .env, then makes one real, minimal API call (a few tokens) and
   reports precisely what came back and what to do about it. */
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');
const line = (s = '') => console.log(s);
const H = s => line('\n' + s + '\n' + '\u2500'.repeat(s.length));

H('1. The .env file');
if (!fs.existsSync(ENV_PATH)) {
  line('  \u2717 No .env at ' + ENV_PATH);
  const sibling = fs.readdirSync(__dirname).filter(f => /^\.env/i.test(f));
  if (sibling.length) line('  \u2192 But found: ' + sibling.join(', ') + '  \u2014 rename it to exactly .env');
  line('  \u2192 Nothing else can be checked until the file exists. Stopping.');
  process.exit(1);
}
const raw = fs.readFileSync(ENV_PATH, 'utf8');
line('  \u2713 Found ' + ENV_PATH + ' (' + raw.length + ' bytes)');

const found = {}, dupes = [];
for (const r of raw.split(/\r?\n/)) {
  const t = r.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq < 1) { line('  ! Ignored line (no "="): ' + t.slice(0, 40)); continue; }
  const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '').trim();
  if (k in found && found[k] !== v) dupes.push(k);
  found[k] = v;
}
for (const k of [...new Set(dupes)]) line('  ! ' + k + ' appears more than once. The LAST one is used \u2014 delete the older lines to avoid confusion.');

const key = process.env.ANTHROPIC_API_KEY || found.ANTHROPIC_API_KEY || '';
const ws = (process.env.ANTHROPIC_WORKSPACE_ID || found.ANTHROPIC_WORKSPACE_ID || '').trim();
const model = process.env.ANTHROPIC_MODEL || found.ANTHROPIC_MODEL || 'claude-opus-5';

if (!key) { line('  \u2717 No ANTHROPIC_API_KEY line found. Add:  ANTHROPIC_API_KEY=sk-ant-...'); process.exit(1); }
line('  \u2713 Key present: ' + key.slice(0, 11) + '\u2026' + key.slice(-4) + '  (length ' + key.length + ')');
if (process.env.ANTHROPIC_API_KEY && found.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== found.ANTHROPIC_API_KEY)
  line('  ! A different ANTHROPIC_API_KEY is set in your shell and it OVERRIDES the file. Close this terminal and open a new one.');
if (!/^sk-ant-/.test(key)) line('  ! Key does not start with sk-ant- \u2014 likely a bad paste.');
if (/\s/.test(key)) line('  ! Key contains a space or line break \u2014 repaste it as a single unbroken line.');
if (key.length < 40) line('  ! Key looks truncated.');
line('  \u2022 Model: ' + model);
line('  \u2022 Workspace id: ' + (ws || 'not set'));

H('2. Live API call');
line('  Sending a minimal request (a few tokens, negligible cost)\u2026');
async function call(withWorkspace) {
  const c = new Anthropic({ apiKey: key,
    ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
    ...(withWorkspace && ws ? { defaultHeaders: { 'anthropic-workspace-id': ws } } : {}) });
  return c.messages.create({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Say OK' }] });
}
function verdict(err) {
  const msg = (err?.message || '') + ' ' + JSON.stringify(err?.error || {});
  if (/anthropic-workspace-id/i.test(msg)) return ['WORKSPACE SCOPING',
    ws ? ['Your key still reports as organisation-scoped even though a workspace id is set.',
      'That usually means the id is wrong or belongs to a different organisation.',
      'Fix: console.anthropic.com \u2192 Settings \u2192 Workspaces \u2192 open the workspace \u2192 copy the id from the URL or the workspace page.',
      'Better: inside that workspace open API Keys \u2192 Create Key, and use that key with no workspace id at all.']
      : ['This key was created at the organisation level.',
        'Fix A: console.anthropic.com \u2192 Settings \u2192 Workspaces \u2192 open a workspace \u2192 API Keys \u2192 Create Key. Put that key in .env.',
        '        The key must be created from INSIDE the workspace, not from the main API Keys page.',
        'Fix B: add ANTHROPIC_WORKSPACE_ID=wrkspc_... to .env and restart.']];
  if (/credit balance|insufficient|quota/i.test(msg)) return ['NO CREDIT',
    ['The API account has no balance. console.anthropic.com \u2192 Billing \u2192 add credit.',
      'Note this is separate from any Claude.ai subscription.']];
  if (/invalid x-api-key|authentication/i.test(msg)) return ['KEY REJECTED',
    ['The key is not valid. It may have been revoked, or the paste is incomplete.',
      'Create a fresh key and replace the whole line in .env.']];
  if (/model/i.test(msg) && /not_found|does not exist|invalid/i.test(msg)) return ['MODEL ID',
    [`"${model}" was rejected. Set ANTHROPIC_MODEL in .env to a current id (try claude-sonnet-5) and rerun.`]];
  if (/permission|forbidden/i.test(msg)) return ['PERMISSIONS',
    ['The key lacks permission for this model. An admin on the organisation controls model access.']];
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network|ETIMEDOUT/i.test(msg)) return ['NETWORK',
    ['Could not reach api.anthropic.com. Check the connection, a VPN, or a corporate proxy/firewall.']];
  return ['UNEXPECTED', [msg.slice(0, 500)]];
}

try {
  const r = await call(true);
  line('  \u2713 SUCCESS \u2014 the API answered: "' + (r.content?.[0]?.text || '').trim() + '"');
  line('  \u2713 Model: ' + r.model + '   tokens in/out: ' + r.usage?.input_tokens + '/' + r.usage?.output_tokens);
  H('Verdict');
  line('  Your key, model and workspace settings are all correct.');
  line('  If the app still fails, it is running with different settings \u2014 stop it (Ctrl+C) and run npm start again.');
} catch (e) {
  const [title, steps] = verdict(e);
  line('  \u2717 FAILED \u2014 HTTP ' + (e.status || '?'));
  H('Verdict: ' + title);
  steps.forEach(s => line('  ' + s));
  if (ws) {
    line('\n  Retrying without the workspace header, to isolate it\u2026');
    try { await call(false); line('  \u2192 It SUCCEEDS without the workspace header. Remove ANTHROPIC_WORKSPACE_ID from .env.'); }
    catch (e2) { line('  \u2192 Also fails without it (HTTP ' + (e2.status || '?') + '), so the workspace header is not the problem.'); }
  }
  line('\n  Paste everything above (the key is already masked) if you want help reading it.');
  process.exit(1);
}
