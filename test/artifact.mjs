// Runs a full edit in the browser, saves the exported PDF to disk, and checks
// it with a parser that is not PDF.js: Spotlight's own PDF importer, the one
// behind Preview and Finder. Catches output that only our own stack can read.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] ?? join(import.meta.dirname, 'out');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8096;
const DEBUG_PORT = 9336;
const profile = mkdtempSync(join(tmpdir(), 'paperstack-artifact-'));
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const server = spawn(process.execPath, ['serve.js', String(PORT)], { stdio: 'ignore' });
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });

let bad = 0;
try {
  await waitFor(() => fetch(`http://localhost:${PORT}/index.html`).then((r) => r.ok), 'server');
  await waitFor(() => fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.ok), 'chrome');

  const t = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?http://localhost:${PORT}/test/harness.html`,
    { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const n = id++; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Runtime.enable');
  const run = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });

  await waitFor(async () => (await run('typeof window.__results')).result?.result?.value === 'object', 'harness');
  await run('window.__results');     // let the suite finish and settle

  const made = await run(`(async () => {
    const S = await import('/js/state.js');
    const { assemble } = await import('/js/assemble.js');
    S.reset();
    const bytes = await fetch('/test/fixture.pdf').then(r => r.arrayBuffer());
    // merge the same document twice, then edit the result
    await S.addPdf(new File([bytes], 'a.pdf', { type: 'application/pdf' }));
    await S.addPdf(new File([bytes], 'b.pdf', { type: 'application/pdf' }));
    S.rotatePages([S.state.pages[0], S.state.pages[5]], 90);
    S.movePages([S.state.pages[7]], 0);
    S.deletePages([S.state.pages[3]]);
    S.duplicatePages([S.state.pages[1]]);
    S.addStamps(S.state.pages, [{ group: 'wm', type: 'text', text: 'CONFIDENTIAL',
      font: 'HelveticaBold', size: 46, color: '#d22', opacity: 0.25, rot: 45, u: 0.5, v: 0.5 }]);
    const out = await assemble(S.state.pages);
    let binary = '';
    for (const b of out) binary += String.fromCharCode(b);
    return { base64: btoa(binary), pages: S.state.pages.length, bytes: out.length };
  })()`);

  const result = made.result?.result?.value;
  if (!result?.base64) throw new Error('export produced nothing');

  const file = join(OUT, 'edited.pdf');
  writeFileSync(file, Buffer.from(result.base64, 'base64'));
  console.log(`exported ${result.pages} pages, ${(result.bytes / 1024).toFixed(1)} KB → ${file}`);

  const expect = (ok, message) => {
    console.log(`  ${ok ? '✓' : '✗'} ${message}`);
    if (!ok) bad++;
  };

  const capture = (cmd, args) => new Promise((resolve) => {
    const child = spawn(cmd, args);
    let text = '';
    child.stdout.on('data', (d) => { text += d; });
    child.stderr.on('data', (d) => { text += d; });
    child.on('close', () => resolve(text));
    child.on('error', () => resolve(''));
  });

  // Independent parse #1: Spotlight's PDF importer, neither PDF.js nor pdf-lib.
  const meta = await capture('mdimport', ['-t', '-d2', file]);
  const pages = meta.match(/kMDItemNumberOfPages\s*=\s*(\d+)/)?.[1];
  const chars = meta.match(/Text content of (\d+) characters/)?.[1];
  const width = meta.match(/kMDItemPageWidth\s*=\s*(\d+)/)?.[1];

  expect(/com\.adobe\.pdf/.test(meta), 'macOS recognizes the file as a PDF');
  expect(Number(pages) === result.pages, `page count agrees: macOS says ${pages}, we wrote ${result.pages}`);
  expect(Number(width) === 612, `page geometry survives: ${width} pt wide`);
  expect(Number(chars) > 100, `the text layer is intact: ${chars} characters readable`);
  expect(/Paperstack/.test(meta), 'producer metadata is set');

  // Independent parse #2: Quick Look draws it with CoreGraphics, the engine
  // Preview uses. A file only our own stack can render would be no good.
  const thumb = await capture('qlmanage', ['-t', '-s', '400', '-o', OUT, file]);
  expect(/produced one thumbnail/.test(thumb), 'Quick Look renders the first page');
} catch (err) {
  console.error('artifact check failed:', err.message);
  bad++;
} finally {
  chrome.kill('SIGKILL');
  server.kill('SIGKILL');
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(bad ? 1 : 0);
}
