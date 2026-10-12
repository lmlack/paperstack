import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeZip } from '../js/lib/zip.js';
import { parseRanges, parseRangeGroups, hexToRgb01, safeName, fmtBytes } from '../js/lib/dom.js';
import { visualSize, toPageSpace, toDisplaySpace, anchorStamp, centerFromAnchor, norm } from '../js/lib/geometry.js';

/* ───────── page ranges ───────── */

test('parseRanges understands single pages, spans and duplicates', () => {
  assert.deepEqual(parseRanges('1-3, 7, 5', 10), [0, 1, 2, 4, 6]);
  assert.deepEqual(parseRanges('4', 10), [3]);
  assert.deepEqual(parseRanges('9-7', 10), [6, 7, 8], 'reversed spans are normalized');
  assert.deepEqual(parseRanges('2-2', 10), [1]);
  assert.deepEqual(parseRanges(' 1 - 2 ,, 4 ', 10), [0, 1, 3], 'whitespace and empty chunks are tolerated');
});

test('parseRanges rejects nonsense and out-of-document pages', () => {
  assert.throws(() => parseRanges('abc', 10), /Cannot read/);
  assert.throws(() => parseRanges('1-99', 10), /outside this document/);
  assert.throws(() => parseRanges('0', 10), /outside this document/);
  assert.throws(() => parseRanges('', 10), /No pages selected/);
});

test('parseRangeGroups keeps each span separate', () => {
  assert.deepEqual(parseRangeGroups('1-3, 7', 10), [[0, 1, 2], [6]]);
});

/* ───────── small helpers ───────── */

test('hexToRgb01 handles both shorthand and full hex', () => {
  assert.deepEqual(hexToRgb01('#ffffff'), { r: 1, g: 1, b: 1 });
  assert.deepEqual(hexToRgb01('#000'), { r: 0, g: 0, b: 0 });
  const red = hexToRgb01('#ff3b30');
  assert.equal(red.r, 1);
  assert.ok(Math.abs(red.g - 0x3b / 255) < 1e-9);
});

test('safeName strips the extension and path-hostile characters', () => {
  assert.equal(safeName('My Report.pdf'), 'My Report');
  assert.equal(safeName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeName(''), 'document');
});

test('fmtBytes is readable at each scale', () => {
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(2048), '2.0 KB');
  assert.equal(fmtBytes(5 * 1024 * 1024), '5.0 MB');
});

/* ───────── stamp geometry ───────── */

test('visualSize swaps the axes on quarter turns only', () => {
  assert.deepEqual(visualSize(612, 792, 0), { vw: 612, vh: 792 });
  assert.deepEqual(visualSize(612, 792, 180), { vw: 612, vh: 792 });
  assert.deepEqual(visualSize(612, 792, 90), { vw: 792, vh: 612 });
  assert.deepEqual(visualSize(612, 792, 270), { vw: 792, vh: 612 });
});

test('display space and page space are exact inverses at every rotation', () => {
  const W = 612, H = 792;
  for (const rot of [0, 90, 180, 270]) {
    const { vw, vh } = visualSize(W, H, rot);
    for (const [vx, vy] of [[0, 0], [vw, 0], [vw, vh], [0, vh], [vw * 0.3, vh * 0.8]]) {
      const page = toPageSpace(vx, vy, W, H, rot);
      // the mapped point must still be inside the unrotated box
      assert.ok(page.x >= -1e-9 && page.x <= W + 1e-9, `x in box at ${rot}°`);
      assert.ok(page.y >= -1e-9 && page.y <= H + 1e-9, `y in box at ${rot}°`);
      const back = toDisplaySpace(page.x, page.y, W, H, rot);
      assert.ok(Math.abs(back.vx - vx) < 1e-9 && Math.abs(back.vy - vy) < 1e-9,
        `round trip at ${rot}° for (${vx},${vy})`);
    }
  }
});

test('a page corner maps to the matching corner of the rotated page', () => {
  const W = 400, H = 800;
  // Bottom-left as displayed, on a page turned 90° clockwise, is the document's
  // top-left corner, which is what a viewer shows you.
  assert.deepEqual(toPageSpace(0, 0, W, H, 90), { x: W, y: 0 });
  assert.deepEqual(toPageSpace(0, 0, W, H, 180), { x: W, y: H });
  assert.deepEqual(toPageSpace(0, 0, W, H, 270), { x: 0, y: H });
});

test('anchorStamp puts the stamp center exactly where it was asked to go', () => {
  const W = 612, H = 792;
  for (const rot of [0, 90, 180, 270]) {
    for (const stampRot of [0, 45, -30]) {
      const stamp = { u: 0.5, v: 0.5, rot: stampRot };
      const anchor = anchorStamp(stamp, { W, H, rot }, 200, 40);
      const center = centerFromAnchor(anchor, 200, 40);
      assert.ok(Math.abs(center.x - W / 2) < 1e-9, `center x at ${rot}/${stampRot}`);
      assert.ok(Math.abs(center.y - H / 2) < 1e-9, `center y at ${rot}/${stampRot}`);
    }
  }
});

test('anchorStamp cancels the page rotation out of the draw angle', () => {
  const box = { W: 612, H: 792, rot: 90 };
  // Asking for 45° on a page displayed 90° clockwise must be drawn at 135°,
  // because the viewer will subtract the page rotation again.
  assert.equal(anchorStamp({ u: 0.5, v: 0.5, rot: 45 }, box, 10, 10).angle, 135);
  assert.equal(anchorStamp({ u: 0.5, v: 0.5, rot: 0 }, { ...box, rot: 0 }, 10, 10).angle, 0);
});

test('a bottom-right watermark lands bottom-right however the page is turned', () => {
  const W = 612, H = 792;
  for (const rot of [0, 90, 180, 270]) {
    const { vw, vh } = visualSize(W, H, rot);
    const anchor = anchorStamp({ u: 0.93, v: 0.07, rot: 0 }, { W, H, rot }, 100, 20);
    const center = centerFromAnchor(anchor, 100, 20);
    const back = toDisplaySpace(center.x, center.y, W, H, rot);
    assert.ok(back.vx / vw > 0.9, `still on the right at ${rot}°`);
    assert.ok(back.vy / vh < 0.1, `still near the bottom at ${rot}°`);
  }
});

test('norm folds any angle into 0-359', () => {
  assert.equal(norm(-90), 270);
  assert.equal(norm(450), 90);
  assert.equal(norm(0), 0);
  assert.equal(norm(-450), 270);
});

/* ───────── the zip writer, checked with a real unzip ───────── */

test('makeZip produces an archive the system unzip accepts', async () => {
  const files = [
    { name: 'one.txt', bytes: new TextEncoder().encode('hello zip') },
    { name: 'nested/two.bin', bytes: new Uint8Array([0, 1, 2, 253, 254, 255]) },
    { name: 'empty.txt', bytes: new Uint8Array(0) },
  ];
  const blob = makeZip(files);
  assert.equal(blob.type, 'application/zip');

  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const zipPath = join(dir, 'out.zip');
  writeFileSync(zipPath, new Uint8Array(await blob.arrayBuffer()));

  // -t makes unzip verify every CRC in the archive.
  const verdict = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
  assert.match(verdict, /No errors detected in compressed data/);

  const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  assert.deepEqual(listing.trim().split('\n'), ['one.txt', 'nested/two.bin', 'empty.txt']);

  execFileSync('unzip', ['-q', '-o', zipPath, '-d', dir]);
  assert.equal(execFileSync('cat', [join(dir, 'one.txt')], { encoding: 'utf8' }), 'hello zip');
});
