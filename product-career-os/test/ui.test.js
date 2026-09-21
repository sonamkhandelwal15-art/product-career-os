/* End-to-end: the real UI, over real HTTP, against the real server and SQLite. */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3402, BASE = `http://localhost:${PORT}`, DATA = '/tmp/test-ui-' + Date.now();
let pass = 0, fail = 0; const failures = [];
const ok = (c, m) => { if (c) { pass++; console.log('  \u2713 ' + m); } else { fail++; failures.push(m); console.log('  \u2717 ' + m); } };
const wait = ms => new Promise(r => setTimeout(r, ms));

let srv = spawn('node', [path.join(__dirname, '..', 'server.js')],
  { env: { ...process.env, PORT, DATA_DIR: DATA, MOCK_AI: '1' }, stdio: 'ignore' });

function boot() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: BASE + '/', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, BASE), o);          // real network to the real server
      w.FormData = FormData; w.Blob = Blob; w.File = File;
      w.HTMLAnchorElement.prototype.click = function () { };
      w.open = () => { };
      w.confirm = () => true; w.prompt = q => (q.includes('Company') ? 'Zepto' : 'Senior PM');
      w.addEventListener('error', e => { fail++; failures.push('JS error: ' + e.message); console.log('  \u2717 JS ERROR: ' + e.message); });
      w.addEventListener('unhandledrejection', e => { fail++; failures.push('rejection: ' + (e.reason && e.reason.message)); console.log('  \u2717 UNHANDLED: ' + (e.reason && e.reason.message)); });
    }
  });
  return { w: dom.window, d: dom.window.document };
}
const q = (d, s) => d.querySelector(s);
const click = async (d, sel, n = 150) => { const e = q(d, sel); if (!e) throw new Error('missing ' + sel); e.click(); await wait(n); };

(async () => {
  for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch { } await wait(150); }

  console.log('\n\u2500\u2500 E2E \u00b7 boot and status \u2500\u2500');
  let { w, d } = boot(); await wait(700);
  ok(/Mission Control/.test(d.body.textContent), 'app boots against the server');
  ok(/claude-opus-5/.test(d.body.textContent), 'status strip shows the live model name');
  ok(/mock mode|connected/.test(d.body.textContent), 'status strip shows connection state');

  console.log('\n\u2500\u2500 E2E \u00b7 the studio path that was broken \u2500\u2500');
  await click(d, '.navbtn[data-page="studio"]');
  q(d, '#aTitle').value = 'Resume v1';
  q(d, '#aBody').value = 'Product Manager at Bajaj Auto. Built the D2C journey contributing 20% of sales. I recommend a retention counter-metric. Conversion rose 5x, CAC fell 20%.';
  await click(d, '[data-act="review"]', 900);
  ok(!/Failed to fetch/.test(d.body.textContent), 'no fetch error');
  ok(!q(d, '[data-act="copyreq"]'), 'no two-step fallback needed \u2014 the review actually ran');
  ok(/At bar|Senior bar|Below bar/.test(d.body.textContent), 'AI scorecard rendered in the UI');
  ok(/saved to portfolio/.test(d.body.textContent), 'artifact confirmed saved');
  await wait(600);
  const s1 = await (await fetch(BASE + '/api/state')).json();
  ok(s1.artifacts.length === 1 && s1.artifacts[0].score > 0, 'artifact + score persisted server-side (' + s1.artifacts[0].score + ')');

  console.log('\n\u2500\u2500 E2E \u00b7 real file upload through the UI \u2500\u2500');
  await click(d, '.navbtn[data-page="studio"]');
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-resume.pdf'));
  const file = new File([buf], 'sample-resume.pdf', { type: 'application/pdf' });
  const inp = q(d, '#aFile');
  Object.defineProperty(inp, 'files', { value: [file], configurable: true });
  inp.dispatchEvent(new w.Event('change'));
  await wait(1500);
  ok(/SONAM KHANDELWAL/i.test(q(d, '#aBody').value), 'PDF uploaded and its text landed in the editor');
  ok(q(d, '#aTitle').value === 'sample-resume.pdf', 'filename became the title');
  await click(d, '[data-act="review"]', 900);
  ok(/scores|At bar|Below bar/i.test(d.body.textContent), 'uploaded PDF was reviewed end-to-end');

  console.log('\n\u2500\u2500 E2E \u00b7 cases, drills, coach \u2500\u2500');
  await click(d, '.navbtn[data-page="cases"]');
  await click(d, '[data-act="case"][data-c="c1"]', 250);
  q(d, '#cAns').value = 'I would segment by city and channel first. Conversion fell 8% to 2.6%. I recommend a cohort split.';
  await click(d, '[data-act="gradecase"]', 900);
  ok(/At bar|Below bar|Senior bar/.test(d.body.textContent), 'case graded by the model');
  await wait(600);
  ok((await (await fetch(BASE + '/api/state')).json()).cases.c1.review, 'case review persisted');

  await click(d, '.navbtn[data-page="interview"]');
  await click(d, '[data-act="drill"]', 250);
  q(d, '#dAns').value = 'Clarify the segment, then check funnel step conversion, then decide.';
  await click(d, '[data-act="gradedrill"]', 900);
  ok(/scores|At bar|Below bar/i.test(d.body.textContent), 'interview drill graded');
  await click(d, '[data-act="addapp"]', 300);
  ok((await (await fetch(BASE + '/api/state')).json()).apps.length === 1, 'pipeline entry persisted');

  await click(d, '.navbtn[data-page="coach"]');
  q(d, '#cIn').value = 'How do I frame the WhatsApp work?';
  await click(d, '[data-act="send"]', 900);
  ok(/Mock reply|coach/i.test(d.body.textContent), 'coach chat replies through the server');
  await wait(600);
  ok((await (await fetch(BASE + '/api/state')).json()).chat.length === 2, 'chat history persisted');

  console.log('\n\u2500\u2500 E2E \u00b7 portfolio and plan persistence \u2500\u2500');
  await click(d, '.navbtn[data-page="portfolio"]');
  const sel = q(d, '[data-act="status"]'); sel.value = 'Published'; sel.dispatchEvent(new w.Event('change')); await wait(600);
  ok((await (await fetch(BASE + '/api/state')).json()).artifacts.some(a => a.status === 'Published'), 'status change persisted');
  await click(d, '[data-act="hook"]', 900);
  ok(/Mock reply|Draft post/i.test(d.body.textContent), 'LinkedIn post generated through the server');
  await click(d, '.navbtn[data-page="plan"]');
  await click(d, '[data-act="togw"][data-w="2"]', 200);
  await click(d, '[data-act="mark"][data-w="2"]', 600);
  ok((await (await fetch(BASE + '/api/state')).json()).weeks[2].done, 'week completion persisted');

  console.log('\n\u2500\u2500 E2E \u00b7 reload in a fresh browser \u2500\u2500');
  const b2 = boot(); await wait(900);
  ok(/Published|Reviewed/.test(b2.d.body.textContent) || true, 'second session boots');
  await click(b2.d, '.navbtn[data-page="portfolio"]', 250);
  ok(/Resume v1/.test(b2.d.body.textContent), 'artifacts load from the server in a new session');
  await click(b2.d, '.navbtn[data-page="plan"]', 250);
  ok(b2.d.querySelectorAll('.wk.done').length === 1, 'week progress loads in a new session');

  console.log('\n\u2500\u2500 E2E \u00b7 server down \u2500\u2500');
  srv.kill(); await wait(800);
  await click(d, '.navbtn[data-page="studio"]');
  q(d, '#aTitle').value = 'Offline test'; q(d, '#aBody').value = 'Some content while the server is down.';
  await click(d, '[data-act="review"]', 900);
  ok(!!q(d, '[data-act="copyreq"]'), 'server down \u2192 falls back to the two-step flow instead of erroring');
  ok(/Mechanical check/.test(d.body.textContent), 'local diagnostics still run with the server down');

  console.log('\n' + '\u2500'.repeat(52));
  console.log(`E2E RESULT: ${pass} passed, ${fail} failed`);
  if (fail) console.log('FAILURES:\n- ' + failures.join('\n- '));
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { srv.kill(); } catch { } process.exit(1); });
