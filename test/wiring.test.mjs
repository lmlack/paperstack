// Static wiring: every element the JS reaches for must exist in index.html, and
// every tool tab must have a panel. Catches typos no unit test would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const classes = new Set(
  [...html.matchAll(/\bclass="([^"]+)"/g)].flatMap((m) => m[1].trim().split(/\s+/)),
);

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsFiles(path);
    return name.endsWith('.js') ? [path] : [];
  });
}

const sources = jsFiles(join(root, 'js')).map((path) => ({
  path: path.slice(root.length + 1),
  text: readFileSync(path, 'utf8'),
}));

test('every #id the JS selects exists in index.html', () => {
  const missing = [];
  for (const { path, text } of sources) {
    for (const m of text.matchAll(/\$\$?\(\s*'#([A-Za-z0-9_-]+)'/g)) {
      if (!ids.has(m[1])) missing.push(`${path} → #${m[1]}`);
    }
    for (const m of text.matchAll(/getElementById\(\s*'([^']+)'/g)) {
      if (!ids.has(m[1])) missing.push(`${path} → #${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `selectors with no matching element:\n${missing.join('\n')}`);
});

test('every class the JS selects appears in the markup or the stylesheet', () => {
  const css = readFileSync(join(root, 'css/app.css'), 'utf8');
  const missing = [];
  for (const { path, text } of sources) {
    for (const m of text.matchAll(/\$\$?\(\s*'\.([A-Za-z0-9_-]+)'/g)) {
      if (!classes.has(m[1]) && !css.includes(`.${m[1]}`)) missing.push(`${path} → .${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `unknown classes:\n${missing.join('\n')}`);
});

test('each tool tab has a matching panel', () => {
  const tabs = [...html.matchAll(/data-panel="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(tabs.length === 6, `expected 6 tabs, found ${tabs.length}`);
  for (const tab of tabs) assert.ok(ids.has(`panel-${tab}`), `no #panel-${tab} for tab "${tab}"`);
});
/**
 * Links the reader can click are navigations, not loads, so they are allowed,
 * but only to places we meant. Everything else that could cause the browser to
 * fetch from a third party stays banned.
 */
const OUTBOUND_ALLOWED = ['https://gwark.dev/', 'https://gwark.dev/#projects'];
const ANCHOR_HREF = /<a\b[^>]*?href="(https?:\/\/[^"]+)"/gi;

test('outbound links go only where we intend', () => {
  const found = [...html.matchAll(ANCHOR_HREF)].map((m) => m[1]);
  assert.ok(found.length > 0, 'expected at least the link home');
  const stray = found.filter((url) => !OUTBOUND_ALLOWED.includes(url));
  assert.deepEqual(stray, [], `unexpected outbound links:\n${stray.join('\n')}`);
});

test('nothing is loaded from the network at runtime', () => {
  const offenders = [];
  const remote = /https?:\/\/(?!localhost|127\.0\.0\.1)[^\s"')]+/g;
  // Anchor targets are covered by the test above; blank them so a link cannot
  // be mistaken for a fetch, and a fetch cannot hide behind a link.
  const scannable = (path, text) => (path === 'index.html'
    ? text.replace(ANCHOR_HREF, (tag) => tag.replace(/https?:\/\/[^"]+/, 'about:blank'))
    : text);

  for (const { path, text } of [...sources, { path: 'index.html', text: html },
    { path: 'css/app.css', text: readFileSync(join(root, 'css/app.css'), 'utf8') }]) {
    for (const m of scannable(path, text).matchAll(remote)) {
      if (/^https?:\/\/www\.w3\.org/.test(m[0])) continue;   // SVG namespace, not a fetch
      offenders.push(`${path} → ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `remote references found:\n${offenders.join('\n')}`);
});

test('every module the app imports exists on disk', () => {
  const missing = [];
  for (const { path, text } of sources) {
    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      const resolved = join(root, path, '..', m[1]);
      try { statSync(resolved); } catch { missing.push(`${path} → ${m[1]}`); }
    }
  }
  assert.deepEqual(missing, [], `broken imports:\n${missing.join('\n')}`);
});
