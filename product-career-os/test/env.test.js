/* Regression: the server must read its key from .env beside server.js,
   regardless of which directory it is launched from. */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ENV = path.join(APP, '.env');
let pass = 0, fail = 0; const failures = [];
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; failures.push(m); console.log('  \u2717 ' + m); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

const hadEnv = fs.existsSync(ENV);
const backup = hadEnv ? fs.readFileSync(ENV, 'utf8') : null;

async function bootAndRead(port, cwd, dataDir) {
  const p = spawn('node', ['--no-warnings', path.join(APP, 'server.js')],
    { env: { ...process.env, PORT: port, DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', MOCK_AI: '' }, cwd, stdio: 'ignore' });
  let health = null;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://localhost:${port}/api/health`); if (r.ok) { health = await r.json(); break; } } catch { }
    await wait(150);
  }
  p.kill();
  await wait(300);
  return health;
}

(async () => {
  console.log('\n\u2500\u2500 .env loading \u2500\u2500');

  // 1. no .env at all
  if (hadEnv) fs.rmSync(ENV);
  let h = await bootAndRead(3411, APP, '/tmp/env-t1');
  ok(h && h.ai === 'no_key', 'no .env \u2192 server still starts and reports no_key');

  // 2. .env present, launched from the app folder
  fs.writeFileSync(ENV, 'ANTHROPIC_API_KEY=sk-ant-test-abcd1234\nANTHROPIC_MODEL=claude-opus-5\n');
  h = await bootAndRead(3412, APP, '/tmp/env-t2');
  ok(h && h.ai === 'live', 'REGRESSION: .env key is loaded (was the reported bug)');
  ok(h && h.model === 'claude-opus-5', 'model name also read from .env');

  // 3. launched from a completely different directory
  h = await bootAndRead(3413, '/tmp', '/tmp/env-t3');
  ok(h && h.ai === 'live', 'key loads even when started from another folder');

  // 4. messy file: quotes, spaces, blank lines, comments, CRLF (Notepad on Windows)
  fs.writeFileSync(ENV, '# comment line\r\n\r\n  ANTHROPIC_API_KEY = "sk-ant-test-wxyz9876"  \r\nANTHROPIC_MODEL=claude-opus-5\r\n');
  h = await bootAndRead(3414, APP, '/tmp/env-t4');
  ok(h && h.ai === 'live', 'tolerates quotes, padding, comments and Windows line endings');

  // 5. real environment variable still wins / works without a file
  fs.rmSync(ENV);
  const p = spawn('node', ['--no-warnings', path.join(APP, 'server.js')],
    { env: { ...process.env, PORT: 3415, DATA_DIR: '/tmp/env-t5', ANTHROPIC_API_KEY: 'sk-ant-from-shell' }, cwd: APP, stdio: 'ignore' });
  let h5 = null;
  for (let i = 0; i < 40; i++) { try { const r = await fetch('http://localhost:3415/api/health'); if (r.ok) { h5 = await r.json(); break; } } catch { } await wait(150); }
  p.kill();
  ok(h5 && h5.ai === 'live', 'a shell-set environment variable works with no .env present');

  if (hadEnv) fs.writeFileSync(ENV, backup); else if (fs.existsSync(ENV)) fs.rmSync(ENV);
  for (const d of ['t1', 't2', 't3', 't4', 't5']) fs.rmSync('/tmp/env-' + d, { recursive: true, force: true });

  console.log('\n' + '\u2500'.repeat(52));
  console.log(`ENV RESULT: ${pass} passed, ${fail} failed`);
  if (fail) console.log('FAILURES:\n- ' + failures.join('\n- '));
  process.exit(fail ? 1 : 0);
})().catch(e => { if (hadEnv) fs.writeFileSync(ENV, backup); console.error(e); process.exit(1); });
