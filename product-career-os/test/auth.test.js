/* Access gate: open locally, locked when APP_PASSWORD is set, refuses to run
   unprotected in production. */
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
let pass = 0, fail = 0; const failures = [];
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; failures.push(m); console.log('  \u2717 ' + m); } };
const wait = ms => new Promise(r => setTimeout(r, ms));
const basic = (u, p) => 'Basic ' + Buffer.from(u + ':' + p).toString('base64');

function start(port, env) {
  return spawn('node', ['--no-warnings', path.join(APP, 'server.js')],
    { env: { ...process.env, PORT: port, DATA_DIR: '/tmp/auth-' + port, MOCK_AI: '1', APP_PASSWORD: '', NODE_ENV: '', ...env }, cwd: APP, stdio: 'ignore' });
}
async function ready(port) {
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://localhost:${port}/healthz`); if (r.ok) return true; } catch { } await wait(150); }
  return false;
}

(async () => {
  console.log('\n\u2500\u2500 access gate \u2500\u2500');

  let s = start(3701, {});
  await ready(3701);
  ok((await fetch('http://localhost:3701/')).status === 200, 'no password set \u2192 open for local use');
  s.kill(); await wait(300);

  s = start(3702, { APP_PASSWORD: 'correct horse battery' });
  await ready(3702);
  let r = await fetch('http://localhost:3702/');
  ok(r.status === 401, 'password set \u2192 the page requires login');
  ok(/Basic/.test(r.headers.get('www-authenticate') || ''), 'browser is told to show its login prompt');
  ok((await fetch('http://localhost:3702/api/state')).status === 401, 'API routes are locked too');
  ok((await fetch('http://localhost:3702/api/ai/review', { method: 'POST' })).status === 401, 'model endpoints are locked \u2014 no one can spend your credit');
  ok((await fetch('http://localhost:3702/', { headers: { Authorization: basic('sonam', 'wrong') } })).status === 401, 'wrong password rejected');
  ok((await fetch('http://localhost:3702/', { headers: { Authorization: basic('someone', 'correct horse battery') } })).status === 401, 'wrong username rejected');
  ok((await fetch('http://localhost:3702/', { headers: { Authorization: basic('sonam', 'correct horse battery') } })).status === 200, 'correct credentials let you in');
  ok((await fetch('http://localhost:3702/healthz')).status === 200, 'health check stays open for the hosting platform');
  s.kill(); await wait(300);

  s = start(3703, { APP_PASSWORD: 'pw:with:colons', APP_USER: 'admin' });
  await ready(3703);
  ok((await fetch('http://localhost:3703/', { headers: { Authorization: basic('admin', 'pw:with:colons') } })).status === 200, 'passwords containing colons work; custom username works');
  s.kill(); await wait(300);

  const code = await new Promise(res => { const p = start(3704, { NODE_ENV: 'production' }); p.on('exit', c => res(c)); setTimeout(() => { p.kill(); res('still running'); }, 4000); });
  ok(code === 1, 'production without a password refuses to start (exit ' + code + ')');

  s = start(3705, { NODE_ENV: 'production', APP_PASSWORD: 'set' });
  ok(await ready(3705), 'production with a password starts normally');
  s.kill();

  for (const p of [3701, 3702, 3703, 3704, 3705]) fs.rmSync('/tmp/auth-' + p, { recursive: true, force: true });
  console.log('\n' + '\u2500'.repeat(52));
  console.log(`AUTH RESULT: ${pass} passed, ${fail} failed`);
  if (fail) console.log('FAILURES:\n- ' + failures.join('\n- '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
