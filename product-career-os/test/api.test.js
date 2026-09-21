/* Integration tests — run against a live server process (mock model). */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3401, BASE = `http://localhost:${PORT}`, DATA = '/tmp/test-career-' + Date.now();
let pass = 0, fail = 0; const failures = [];
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; failures.push(m); console.log('  \u2717 ' + m); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn('node', [path.join(__dirname, '..', 'server.js')],
  { env: { ...process.env, PORT, DATA_DIR: DATA, MOCK_AI: '1' }, stdio: 'ignore' });

async function up(file) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', file))]), file);
  const r = await fetch(BASE + '/api/upload', { method: 'POST', body: fd });
  return { status: r.status, body: await r.json() };
}
const post = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };

(async () => {
  for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch { } await wait(150); }

  console.log('\n\u2500\u2500 API \u00b7 health & storage \u2500\u2500');
  const h = await (await fetch(BASE + '/api/health')).json();
  ok(h.ok && h.model === 'claude-opus-5', 'health reports the configured model (' + h.model + ')');

  ok((await (await fetch(BASE + '/api/state')).json()) === null, 'empty install returns null state');
  const st = { profile: { name: 'Sonam', context: 'PM at Bajaj Auto', role: 'Senior PM', city: 'Bengaluru' }, weeks: { 1: { done: true } }, artifacts: [], cases: {}, apps: [], chat: [] };
  ok((await fetch(BASE + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) })).ok, 'state saves');
  const got = await (await fetch(BASE + '/api/state')).json();
  ok(got.profile.name === 'Sonam' && got.weeks[1].done, 'state round-trips through SQLite');
  st.artifacts.push({ id: 'a1', title: 'Teardown', score: 4.5 });
  await fetch(BASE + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) });
  ok((await (await fetch(BASE + '/api/state')).json()).artifacts.length === 1, 'incremental updates persist');
  ok((await fetch(BASE + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '"nope"' })).status === 400, 'malformed state rejected with 400');
  ok((await (await fetch(BASE + '/api/state')).json()).artifacts.length === 1, 'rejected write did not corrupt stored state');

  console.log('\n\u2500\u2500 API \u00b7 file extraction (the thing the browser could not do) \u2500\u2500');
  const pdf = await up('sample-resume.pdf');
  ok(pdf.status === 200 && /SONAM KHANDELWAL/i.test(pdf.body.text), 'PDF text extracted (' + pdf.body.words + ' words)');
  ok(/300\+ channel partners/.test(pdf.body.text), 'PDF extraction preserves detail lines');
  const dx = await up('sample-teardown.docx');
  ok(dx.status === 200 && /22% drop/.test(dx.body.text), 'DOCX text extracted (' + dx.body.words + ' words)');
  const md = await up('sample.md');
  ok(md.status === 200 && /counter-metric/.test(md.body.text), 'Markdown accepted');
  const fd = new FormData(); fd.append('file', new Blob([Buffer.from([0, 1, 2])]), 'thing.exe');
  ok((await fetch(BASE + '/api/upload', { method: 'POST', body: fd })).status === 415, 'unsupported type rejected with 415');
  ok((await fetch(BASE + '/api/upload', { method: 'POST', body: new FormData() })).status === 400, 'empty upload rejected with 400');

  console.log('\n\u2500\u2500 API \u00b7 model endpoints \u2500\u2500');
  const rev = await post('/api/ai/review', { type: 'resume', label: 'Resume / LinkedIn', dims: ['Scope signal', 'Quantified outcome'], title: 'Resume v1', content: pdf.body.text, profile: st.profile });
  ok(rev.status === 200 && Array.isArray(rev.body.scores), 'review returns a structured scorecard');
  ok(typeof rev.body.scoreAvg === 'number', 'server computes the average score (' + rev.body.scoreAvg + ')');
  ok(/claude/i.test(rev.body.src || ''), 'review is stamped with its model source');
  ok((await post('/api/ai/review', { content: '' })).status === 400, 'empty review request rejected with 400');
  ok((await post('/api/ai/chat', { messages: [{ r: 'u', c: 'hello' }], profile: st.profile })).body.text.length > 0, 'chat endpoint replies');
  ok((await post('/api/ai/hook', { title: 'Teardown', content: 'body' })).body.text.length > 0, 'post-generator endpoint replies');

  console.log('\n\u2500\u2500 API \u00b7 backup, snapshots, telemetry \u2500\u2500');
  const ex = await fetch(BASE + '/api/export');
  ok(ex.headers.get('content-disposition').includes('attachment'), 'export downloads as a file');
  const exb = await ex.json();
  ok(exb.state.profile.name === 'Sonam' && exb.files.length === 3, 'export carries state and file index');
  const snaps = await (await fetch(BASE + '/api/snapshots')).json();
  ok(snaps.length >= 1, 'snapshot written automatically');
  st.profile.name = 'Broken'; await fetch(BASE + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) });
  await post(`/api/snapshots/${snaps[0].id}/restore`, {});
  const restored = await (await fetch(BASE + '/api/state')).json();
  ok(restored.profile.name === 'Sonam' && restored.artifacts.length === 0, 'snapshot restore rolls state back to the snapshot point');
  st.profile.name = 'Sonam';
  await fetch(BASE + '/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) });
  ok((await fetch(BASE + '/api/snapshots/9999/restore', { method: 'POST' })).status === 404, 'restoring a missing snapshot 404s');
  const usage = await (await fetch(BASE + '/api/usage')).json();
  ok(usage.some(u => u.kind === 'review') && usage.every(u => u.calls > 0), 'every model call is logged for cost tracking');

  console.log('\n\u2500\u2500 API \u00b7 durability \u2500\u2500');
  srv.kill(); await wait(600);
  const srv2 = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DATA, MOCK_AI: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch { } await wait(150); }
  const after = await (await fetch(BASE + '/api/state')).json();
  ok(after.profile.name === 'Sonam' && after.artifacts.length === 1, 'data survives a full server restart');
  srv2.kill();

  console.log('\n' + '\u2500'.repeat(52));
  console.log(`API RESULT: ${pass} passed, ${fail} failed`);
  if (fail) console.log('FAILURES:\n- ' + failures.join('\n- '));
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
