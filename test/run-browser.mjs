// Runs the browser tests in real headless Chrome against the real server,
// talking CDP over Node's built-in WebSocket. Two phases:
//   1. test/suite.js    the modules, and the PDFs they actually produce
//   2. test/ui-probe.js index.html, clicked through like a user

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT) || 8099;
const DEBUG_PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'paperstack-chrome-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { if (await fn()) return true; } catch { /* keep waiting */ }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Opens a tab and returns an `evaluate` bound to it, plus its console output. */
async function openPage(path) {
  const target = await fetch(
    `http://127.0.0.1:${DEBUG_PORT}/json/new?http://localhost:${PORT}${path}`,
    { method: 'PUT' },
  ).then((r) => r.json());

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const consoleLines = [];

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
      consoleLines.push(`[${msg.params.type}] ${text}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleLines.push(`[exception] ${d.exception?.description ?? d.text}`);
    }
  });

  const send = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');

  return {
    consoleLines,
    close: () => ws.close(),
    evaluate: (expression, awaitPromise = false) =>
      send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }),
  };
}

function report(title, results, consoleLines) {
  console.log(`\n── ${title} ──`);
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`  ✓ ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
    } else {
      failed++;
      console.log(`  ✗ ${r.name}\n      ${String(r.detail).split('\n').join('\n      ')}`);
    }
  }
  console.log(`  ${results.length - failed}/${results.length} passed`);

  const noise = (consoleLines ?? []).filter((l) => !l.startsWith('[log]'));
  if (noise.length) {
    console.log('  browser console:');
    for (const line of noise.slice(0, 20)) console.log('    ' + line);
  }
  return failed;
}

/** Pulls the results array out of an evaluate reply, or explains what came back. */
function resultsFrom(reply, what) {
  const value = reply.result?.result?.value;
  if (Array.isArray(value)) return value;
  console.error(JSON.stringify(reply, null, 2));
  throw new Error(`${what} produced nothing`);
}

const server = spawn(process.execPath, ['serve.js', String(PORT)], { stdio: 'inherit' });
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-gpu', '--mute-audio', '--window-size=1400,900',
  'about:blank',
], { stdio: 'ignore' });

let code = 1;
try {
  await waitFor(() => fetch(`http://localhost:${PORT}/index.html`).then((r) => r.ok), 'the static server');
  await waitFor(() => fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.ok), 'Chrome');

  let failed = 0;

  const modules = await openPage('/test/harness.html');
  await waitFor(async () => {
    const r = await modules.evaluate('typeof window.__results');
    return r.result?.result?.value === 'object';
  }, 'the harness to boot');
  failed += report('module + output checks',
    resultsFrom(await modules.evaluate('window.__results', true), 'the module suite'),
    modules.consoleLines);
  modules.close();

  const app = await openPage('/index.html');
  await waitFor(async () => {
    const r = await app.evaluate('!!document.querySelector("#btnExport")');
    return r.result?.result?.value === true;
  }, 'the app to load');
  failed += report('user interface checks',
    resultsFrom(await app.evaluate('(async () => (await import("/test/ui-probe.js")).probe())()', true),
      'the UI probe'),
    app.consoleLines);
  app.close();

  console.log(failed ? `\n${failed} check(s) failed` : '\nall browser checks passed');
  code = failed ? 1 : 0;
} catch (err) {
  console.error('\nrunner error:', err.message);
} finally {
  chrome.kill('SIGKILL');
  server.kill('SIGKILL');
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(code);
}
