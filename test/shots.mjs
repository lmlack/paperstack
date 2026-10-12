// Captures screenshots of the real app in a few states, so the design can be
// looked at rather than imagined. Writes PNGs to the directory given as $1.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] ?? join(import.meta.dirname, 'shots');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8098;
const DEBUG_PORT = 9334;
const profile = mkdtempSync(join(tmpdir(), 'paperstack-shots-'));
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
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=2', '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

try {
  await waitFor(() => fetch(`http://localhost:${PORT}/index.html`).then((r) => r.ok), 'server');
  await waitFor(() => fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.ok), 'chrome');

  const target = await fetch(
    `http://127.0.0.1:${DEBUG_PORT}/json/new?http://localhost:${PORT}/index.html`,
    { method: 'PUT' },
  ).then((r) => r.json());

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const n = id++;
    pending.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  const run = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const shot = async (name) => {
    await sleep(400);
    // headless Chrome only composites when something asks it to; wait for two
    // real animation frames or the capture returns whatever was last drawn.
    await run('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await send('Page.bringToFront');
    const { result } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, 'base64'));
    console.log('wrote', `${name}.png`);
  };

  await waitFor(async () => (await run('!!document.querySelector("#dropzone")')).result?.result?.value, 'app');
  await shot('1-empty-dark');

  await run(`document.documentElement.dataset.theme = 'light'`);
  await shot('2-empty-light');
  await run(`document.documentElement.dataset.theme = 'dark'`);

  await run(`(async () => {
    const bytes = await fetch('/test/fixture.pdf').then(r => r.arrayBuffer());
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'quarterly-report.pdf', { type: 'application/pdf' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const { state } = await import('/js/state.js');
    for (let i = 0; i < 100 && state.pages.length < 4; i++) await new Promise(r => setTimeout(r, 50));
    // duplicate a few pages so the grid looks like real work
    const { duplicatePages } = await import('/js/state.js');
    duplicatePages([state.pages[0], state.pages[1]]);
    for (let i = 0; i < 100 && document.querySelectorAll('#pagegrid .tile canvas').length < 6; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
  })()`);
  await shot('3-pages-dark');

  await run(`(async () => {
    document.querySelector('.dock-tab[data-panel="mark"]').click();
    document.querySelector('#wmValue').value = 'CONFIDENTIAL';
    document.querySelector('#wmOp').value = '30';
    document.querySelector('#btnWmApply').click();
    await new Promise(r => setTimeout(r, 400));
  })()`);
  await shot('4-watermark-dark');

  await run(`document.documentElement.dataset.theme = 'light'`);
  await shot('5-watermark-light');

  await run(`(async () => {
    document.querySelector('.dock-tab[data-panel="sign"]').click();
    const pad = document.querySelector('#sigPad');
    const b = pad.getBoundingClientRect();
    const ev = (t, fx, fy) => pad.dispatchEvent(new PointerEvent(t, {
      pointerId: 1, bubbles: true, clientX: b.left + b.width * fx, clientY: b.top + b.height * fy }));
    ev('pointerdown', 0.12, 0.62);
    for (let i = 1; i <= 40; i++) {
      const t = i / 40;
      ev('pointermove', 0.12 + t * 0.6, 0.62 - Math.sin(t * Math.PI * 2.4) * 0.22 - t * 0.08);
    }
    ev('pointerup', 0.72, 0.5);
    await new Promise(r => setTimeout(r, 200));
  })()`);
  await shot('6-signature-pad');

  await run(`(async () => {
    document.querySelector('#btnSigPlace').click();
    for (let i = 0; i < 100 && document.querySelector('#placeModal').hidden; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
  })()`);
  await shot('7-place-signature');

  await run(`(async () => {
    document.querySelector('#placeCancel').click();
    document.querySelector('#pagegrid .tile .expand span').click();
    for (let i = 0; i < 100 && document.querySelector('#viewer').hidden; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    for (let i = 0; i < 100 && document.querySelector('#viewer').classList.contains('busy'); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
  })()`);
  await shot('8-viewer-light');

  await run(`document.documentElement.dataset.theme = 'dark'`);
  await shot('9-viewer-dark');

  // narrow viewport, to prove the layout holds up
  await run(`document.querySelector('#viewClose').click()`);
  await send('Emulation.setDeviceMetricsOverride',
    { width: 430, height: 940, deviceScaleFactor: 2, mobile: true });
  await run(`document.querySelector('.dock-tab[data-panel="pages"]').click(); window.scrollTo(0,0)`);
  await shot('10-phone');
} catch (err) {
  console.error('shots failed:', err.message);
  process.exitCode = 1;
} finally {
  chrome.kill('SIGKILL');
  server.kill('SIGKILL');
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
