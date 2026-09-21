/* Workspace scoping + error translation.
   Runs the server against a fake Anthropic endpoint so we can inspect the exact
   headers it sends and the exact errors it turns into guidance. No real API calls. */
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
let pass = 0, fail = 0; const failures = [];
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; failures.push(m); console.log('  \u2717 ' + m); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

/* fake api.anthropic.com */
let lastHeaders = null, nextResponse = null;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    lastHeaders = req.headers;
    const r = nextResponse || { status: 200, body: { content: [{ type: 'text', text: '{"level":"At bar","headline":"h","scores":[{"dim":"A","score":4,"why":"w"}],"strengths":[],"fixes":[],"rewrite":"","next":"n"}' }], usage: { input_tokens: 10, output_tokens: 5 } } };
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
});

async function startServer(port, extraEnv) {
  const p = spawn('node', ['--no-warnings', path.join(APP, 'server.js')], {
    env: {
      ...process.env, PORT: port, DATA_DIR: '/tmp/ws-' + port, MOCK_AI: '',
      ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: 'http://localhost:3500', ...extraEnv
    }, cwd: APP, stdio: 'ignore'
  });
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://localhost:${port}/api/health`); if (r.ok) break; } catch { } await wait(150); }
  return p;
}
const review = (port) => fetch(`http://localhost:${port}/api/ai/review`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'strategy', label: 'Strategy', dims: ['A'], title: 't', content: 'some artifact content' })
});

(async () => {
  await new Promise(r => fake.listen(3500, r));

  console.log('\n\u2500\u2500 workspace scoping \u2500\u2500');
  let srv = await startServer(3501, {});
  let h = await (await fetch('http://localhost:3501/api/health')).json();
  ok(h.workspace === 'not set', 'health reports when no workspace is configured');
  await review(3501);
  ok(lastHeaders && !lastHeaders['anthropic-workspace-id'], 'no workspace header sent when none is configured');
  srv.kill(); await wait(400);

  srv = await startServer(3502, { ANTHROPIC_WORKSPACE_ID: 'wrkspc_test123' });
  h = await (await fetch('http://localhost:3502/api/health')).json();
  ok(h.workspace === 'set', 'health reports a configured workspace');
  lastHeaders = null;
  const good = await review(3502);
  ok(lastHeaders && lastHeaders['anthropic-workspace-id'] === 'wrkspc_test123', 'FIX: anthropic-workspace-id header is sent on the request');
  ok(good.status === 200, 'review succeeds when the workspace is supplied');
  srv.kill(); await wait(400);

  srv = await startServer(3503, { ANTHROPIC_WORKSPACE_ID: '  wrkspc_padded  ' });
  await review(3503);
  ok(lastHeaders['anthropic-workspace-id'] === 'wrkspc_padded', 'stray whitespace in the id is trimmed');
  srv.kill(); await wait(400);

  console.log('\n\u2500\u2500 error translation \u2500\u2500');
  srv = await startServer(3504, {});

  nextResponse = { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.' } } };
  let r = await review(3504); let b = await r.json();
  ok(b.code === 'workspace_required', 'REGRESSION: the reported 400 maps to workspace_required');
  ok(/console\.anthropic\.com/.test(b.error) && /ANTHROPIC_WORKSPACE_ID/.test(b.error), 'the message tells the user both ways to fix it');
  ok(!/request_id|invalid_request_error/.test(b.error), 'raw API noise is not shown to the user');

  nextResponse = { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } };
  b = await (await review(3504)).json();
  ok(b.code === 'no_credit' && /Billing/.test(b.error), 'low balance maps to a billing message');

  nextResponse = { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
  b = await (await review(3504)).json();
  ok(b.code === 'bad_key', 'bad key maps to a key message');

  nextResponse = { status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'model: claude-opus-5 does not exist' } } };
  b = await (await review(3504)).json();
  ok(b.code === 'bad_model' && /ANTHROPIC_MODEL/.test(b.error), 'unknown model maps to a model message');

  nextResponse = { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'rate_limit exceeded' } } };
  b = await (await review(3504)).json();
  ok(b.code === 'rate_limited', 'rate limiting maps to a wait-and-retry message');

  nextResponse = null;
  b = await (await review(3504)).json();
  ok(Array.isArray(b.scores), 'recovers and works normally after errors');
  srv.kill();

  await new Promise(r => fake.close(r));
  for (const p of [3501, 3502, 3503, 3504]) fs.rmSync('/tmp/ws-' + p, { recursive: true, force: true });
  console.log('\n' + '\u2500'.repeat(52));
  console.log(`WORKSPACE RESULT: ${pass} passed, ${fail} failed`);
  if (fail) console.log('FAILURES:\n- ' + failures.join('\n- '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
