/* Tests the doctor against a fake Anthropic endpoint, one scenario per failure mode.
   Backs up and restores any real .env. */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ENV = path.join(APP, '.env');
let pass = 0, fail = 0; const failures = [];
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; failures.push(m); console.log('  \u2717 ' + m); } };

const hadEnv = fs.existsSync(ENV);
const backup = hadEnv ? fs.readFileSync(ENV, 'utf8') : null;
let nextResponse = null;
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => {
    const r = nextResponse || { status: 200, body: { model: 'claude-opus-5', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 5, output_tokens: 2 } } };
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.body));
  });
});
const err = (status, message, type = 'invalid_request_error') => ({ status, body: { type: 'error', error: { type, message } } });

function runDoctor() {
  return new Promise(resolve => {
    execFile('node', ['--no-warnings', path.join(APP, 'doctor.js')],
      { env: { ...process.env, ANTHROPIC_BASE_URL: 'http://localhost:3600', ANTHROPIC_API_KEY: '', ANTHROPIC_WORKSPACE_ID: '', ANTHROPIC_MODEL: '' }, cwd: APP },
      (e, stdout, stderr) => resolve((stdout || '') + (stderr || '')));
  });
}
const writeEnv = s => fs.writeFileSync(ENV, s);

(async () => {
  await new Promise(r => fake.listen(3600, r));
  console.log('\n\u2500\u2500 doctor \u2500\u2500');

  writeEnv('ANTHROPIC_API_KEY=sk-ant-test-key-1234567890123456789012345678901234\n');
  nextResponse = null;
  let out = await runDoctor();
  ok(/SUCCESS/.test(out), 'healthy setup reports success');
  ok(!/sk-ant-test-key-1234567890123456789012345678901234/.test(out), 'the full key is never printed');
  ok(/sk-ant-test\u2026|sk-ant-test/.test(out), 'a masked key fragment is shown for identification');

  nextResponse = err(400, 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.');
  out = await runDoctor();
  ok(/WORKSPACE SCOPING/.test(out), 'the reported error is identified as workspace scoping');
  ok(/created from INSIDE the workspace/.test(out), 'explains the trap: the key must be created inside the workspace');

  writeEnv('ANTHROPIC_API_KEY=sk-ant-test-key-1234567890123456789012345678901234\nANTHROPIC_WORKSPACE_ID=wrkspc_wrong\n');
  out = await runDoctor();
  ok(/id is wrong or belongs to a different organisation/.test(out), 'with a workspace id set, it suspects the id itself');
  ok(/Retrying without the workspace header/.test(out), 'isolates the header by retrying without it');

  writeEnv('ANTHROPIC_API_KEY=sk-ant-test-key-1234567890123456789012345678901234\n');
  nextResponse = err(400, 'Your credit balance is too low to access the Anthropic API.');
  ok(/NO CREDIT/.test(await runDoctor()), 'low balance identified');

  nextResponse = err(401, 'invalid x-api-key', 'authentication_error');
  ok(/KEY REJECTED/.test(await runDoctor()), 'rejected key identified');

  nextResponse = err(404, 'model: claude-opus-5 does not exist', 'not_found_error');
  ok(/MODEL ID/.test(await runDoctor()), 'bad model id identified');

  nextResponse = null;
  writeEnv('ANTHROPIC_API_KEY=sk-ant-OLDOLDOLD1234567890123456789012345678\nANTHROPIC_API_KEY=sk-ant-NEWNEWNEW1234567890123456789012345678\n');
  out = await runDoctor();
  ok(/appears more than once/.test(out), 'duplicate key lines are flagged');
  ok(/NEWN/.test(out) && !/OLDO/.test(out), 'the LAST duplicate is the one used');

  writeEnv('# just a comment\nANTHROPIC_MODEL=claude-sonnet-5\n');
  out = await runDoctor();
  ok(/No ANTHROPIC_API_KEY line found/.test(out), 'missing key line reported plainly');

  writeEnv('ANTHROPIC_API_KEY = "sk-ant-quoted-key-12345678901234567890123456"  \n');
  nextResponse = null;
  out = await runDoctor();
  ok(/SUCCESS/.test(out), 'quotes and padding tolerated');

  fs.rmSync(ENV);
  out = await runDoctor();
  ok(/No .env at/.test(out), 'missing .env reported with its expected path');

  if (hadEnv) fs.writeFileSync(ENV, backup);
  await new Promise(r => fake.close(r));
  console.log('\n' + '\u2500'.repeat(52));
  console.log(`DOCTOR RESULT: ${pass} passed, ${fail} failed`);
  if (fail) console.log('FAILURES:\n- ' + failures.join('\n- '));
  process.exit(fail ? 1 : 0);
})().catch(e => { if (hadEnv) fs.writeFileSync(ENV, backup); console.error(e); process.exit(1); });
