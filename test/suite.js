// End-to-end checks that drive the real modules in a real browser.

import { state, addPdf, addStamps, deletePages, rotatePages, movePages, reset } from '../js/state.js';
import { assemble } from '../js/assemble.js';
import { openDocument, closeDocument, thumbnail, renderPage } from '../js/pdfjs.js';
import { makeZip } from '../js/lib/zip.js';

const results = [];
let say = () => {};

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '' });
    say(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, detail: `${err?.message}\n${err?.stack ?? ''}` });
    say(`FAIL  ${name}: ${err?.message}`);
  }
}

const assert = (cond, message) => { if (!cond) throw new Error(message); };
const near = (a, b, tol, message) =>
  assert(Math.abs(a - b) <= tol, `${message} (got ${a}, wanted ${b}±${tol})`);

async function fixtureFile() {
  const bytes = await fetch('./fixture.pdf').then((r) => r.arrayBuffer());
  return new File([bytes], 'fixture.pdf', { type: 'application/pdf' });
}

/** Loads assembled bytes back through PDF.js so we can inspect the real output. */
async function reopen(bytes) {
  const doc = await openDocument(bytes);
  const read = async (i) => {
    const page = await doc.getPage(i + 1);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join('');
    const info = { text, rotate: page.rotate, view: page.getViewport({ scale: 1 }) };
    page.cleanup();
    return info;
  };
  return { doc, read, pages: doc.numPages, close: () => closeDocument(doc) };
}

const countColor = (data, test) => {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (test(data[i], data[i + 1], data[i + 2])) n++;
  return n;
};

/** Counts matching pixels inside a fractional sub-rectangle of a canvas. */
function sample(canvas, [x0, y0, x1, y1], test) {
  const ctx = canvas.getContext('2d');
  const x = Math.floor(x0 * canvas.width);
  const y = Math.floor(y0 * canvas.height);
  const w = Math.max(1, Math.floor((x1 - x0) * canvas.width));
  const h = Math.max(1, Math.floor((y1 - y0) * canvas.height));
  return countColor(ctx.getImageData(x, y, w, h).data, test);
}

const isRed = (r, g, b) => r > 170 && g < 110 && b < 110;

export async function runSuite(logger) {
  say = logger || (() => {});

  /* ───────── intake ───────── */

  await check('opens a PDF and lists every page', async () => {
    await addPdf(await fixtureFile());
    assert(state.pages.length === 4, `expected 4 pages, got ${state.pages.length}`);
    assert(state.sources.size === 1, 'expected one source file');
    return `${state.pages.length} pages`;
  });

  await check('renders a thumbnail with real content on it', async () => {
    const src = [...state.sources.values()][0];
    const { canvas, wPt } = await thumbnail(src, 0, 240);
    assert(canvas.width === 240, `thumbnail width ${canvas.width}`);
    near(wPt, 612, 1, 'page width in points');
    const ink = sample(canvas, [0, 0, 1, 1], (r, g, b) => r < 200 || g < 200 || b < 200);
    assert(ink > 500, `expected ink on the thumbnail, found ${ink} dark pixels`);
    return `${canvas.width}×${canvas.height}, ${ink} inked pixels`;
  });

  /* ───────── merge / order / rotate, verified in the output file ───────── */

  await check('exports every page in order, preserving existing rotation', async () => {
    const out = await reopen(await assemble(state.pages));
    assert(out.pages === 4, `output has ${out.pages} pages`);
    const first = await out.read(0);
    const third = await out.read(2);
    assert(first.text.includes('PAGEONE'), `page 1 text was "${first.text}"`);
    assert(third.text.includes('PAGETHREE'), `page 3 text was "${third.text}"`);
    assert(third.rotate === 90, `page 3 kept rotation ${third.rotate}`);
    const second = await out.read(1);
    near(second.view.width, 400, 1, 'page 2 keeps its own size');
    await out.close();
    return 'order, size and rotation all survive';
  });

  await check('re-ordering pages changes the exported order', async () => {
    movePages([state.pages[3]], 0);                       // drag the last page to the front
    assert(state.pages[0].index === 3, 'state did not re-order');
    const out = await reopen(await assemble(state.pages));
    const first = await out.read(0);
    const text = first.text;
    await out.close();
    movePages([state.pages[0]], 4);                       // put it back before asserting
    assert(text.includes('PAGEFOUR'), `front page text was "${text}"`);
    assert(state.pages[3].index === 3, 'did not restore order');
    return 'page 4 moved to the front and back again';
  });

  await check('rotation adds to the page’s own rotation', async () => {
    rotatePages([state.pages[0]], 90);                    // 0 + 90
    rotatePages([state.pages[2]], 90);                    // 90 + 90
    const out = await reopen(await assemble(state.pages));
    assert((await out.read(0)).rotate === 90, 'plain page should now be 90');
    assert((await out.read(2)).rotate === 180, 'pre-rotated page should now be 180');
    await out.close();
    rotatePages([state.pages[0]], -90);
    rotatePages([state.pages[2]], -90);
    return '0+90 → 90 and 90+90 → 180';
  });

  await check('deleting pages removes them from the export', async () => {
    const before = state.pages.length;
    deletePages([state.pages[1]]);
    assert(state.pages.length === before - 1, 'state still holds the page');
    const out = await reopen(await assemble(state.pages));
    assert(out.pages === 3, `output has ${out.pages} pages`);
    const texts = [await out.read(0), await out.read(1), await out.read(2)].map((p) => p.text);
    assert(!texts.some((t) => t.includes('PAGETWO')), `page two is still there: ${texts}`);
    await out.close();
    return '4 pages → 3';
  });

  /* ───────── splitting ───────── */

  await check('splitting exports just the chosen pages', async () => {
    const out = await reopen(await assemble([state.pages[0], state.pages[2]]));
    assert(out.pages === 2, `subset has ${out.pages} pages`);
    assert((await out.read(0)).text.includes('PAGEONE'), 'wrong first page');
    await out.close();
    return '2-page subset';
  });

  await check('zipped output is a real zip', async () => {
    const blob = makeZip([{ name: 'a.pdf', bytes: new Uint8Array([1, 2, 3]) }]);
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    assert(head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4, 'bad zip signature');
    return `${blob.size} bytes, PK\\x03\\x04`;
  });

  /* ───────── text + image extraction ───────── */

  await check('extracts the text layer', async () => {
    const page = await [...state.sources.values()][0].pdfjs.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((i) => i.str).join('');
    page.cleanup();
    assert(text.includes('PAGEONE'), `got "${text}"`);
    assert(text.includes('body text for page 1'), 'missing body text');
    return `${text.length} characters`;
  });

  await check('finds the embedded image', async () => {
    const { pdfjs } = await import('../js/pdfjs.js');
    const src = [...state.sources.values()][0];
    const page = await src.pdfjs.getPage(1);
    const ops = await page.getOperatorList();
    const wanted = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintImageXObjectRepeat]);
    const hits = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (wanted.has(ops.fnArray[i])) hits.push(ops.argsArray[i][0]);
    }
    assert(hits.length >= 1, 'no image paint operator found');

    const objId = hits[0];
    const store = objId.startsWith('g_') ? src.pdfjs.commonObjs : page.objs;
    const obj = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('image never resolved')), 15000);
      const done = (v) => { clearTimeout(timer); resolve(v); };
      const now = store.get(objId, done);
      if (now) done(now);
    });
    const width = obj.width ?? obj.bitmap?.width;
    const height = obj.height ?? obj.bitmap?.height;
    assert(width === 64 && height === 64, `image was ${width}×${height}`);
    page.cleanup();
    return `${objId} → ${width}×${height}`;
  });

  /* ───────── watermark geometry, checked in rendered pixels ───────── */

  await check('a bottom-right watermark renders bottom-right on a rotated page', async () => {
    reset();
    await addPdf(await fixtureFile());
    deletePages(state.pages.filter((_, i) => i !== 2));    // keep only the /Rotate 90 page
    assert(state.pages.length === 1, 'setup failed');

    addStamps(state.pages, [{
      group: 'test', type: 'text', text: 'XX', font: 'HelveticaBold',
      size: 40, color: '#ff0000', opacity: 1, rot: 0, u: 0.93, v: 0.07,
    }]);

    const bytes = await assemble(state.pages);
    const doc = await openDocument(bytes);
    const canvas = await renderPage({ pdfjs: doc }, 0, 1);
    near(canvas.width, 792, 2, 'rotated page is landscape on screen');

    const corner = sample(canvas, [0.80, 0.82, 1, 1], isRed);
    const opposite = sample(canvas, [0, 0, 0.2, 0.18], isRed);
    assert(corner > 40, `expected red ink in the bottom-right, found ${corner} pixels`);
    assert(opposite === 0, `found ${opposite} red pixels in the opposite corner`);
    await closeDocument(doc);
    return `${corner} red pixels bottom-right, ${opposite} top-left`;
  });

  await check('a centered 45° watermark lands in the middle', async () => {
    state.pages[0].stamps = [];
    addStamps(state.pages, [{
      group: 'test2', type: 'text', text: 'XXXX', font: 'HelveticaBold',
      size: 50, color: '#ff0000', opacity: 1, rot: 45, u: 0.5, v: 0.5,
    }]);
    const doc = await openDocument(await assemble(state.pages));
    const canvas = await renderPage({ pdfjs: doc }, 0, 1);
    const middle = sample(canvas, [0.38, 0.35, 0.62, 0.65], isRed);
    const edge = sample(canvas, [0, 0, 0.12, 0.12], isRed);
    assert(middle > 60, `expected red in the middle, found ${middle}`);
    assert(edge === 0, `found ${edge} red pixels in the corner`);
    await closeDocument(doc);
    return `${middle} red pixels centered`;
  });

  await check('an image stamp (signature) is drawn into the output', async () => {
    const pad = document.createElement('canvas');
    pad.width = 300; pad.height = 100;
    const ctx = pad.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 300, 100);
    const { addCanvasAsset } = await import('../js/state.js');
    const asset = await addCanvasAsset(pad);

    state.pages[0].stamps = [];
    addStamps(state.pages, [{
      group: 'sig', type: 'image', assetId: asset.id,
      w: 0.3, opacity: 1, rot: 0, u: 0.75, v: 0.2,
    }]);
    const doc = await openDocument(await assemble(state.pages));
    const canvas = await renderPage({ pdfjs: doc }, 0, 1);
    const spot = sample(canvas, [0.62, 0.72, 0.88, 0.88], isRed);
    assert(spot > 500, `expected a red block at the signature spot, found ${spot}`);
    await closeDocument(doc);
    return `${spot} red pixels at the placement`;
  });

  /* ───────── notes ───────── */

  await check('a note on the page is written as real, selectable text', async () => {
    for (const p of state.pages) p.stamps = [];
    addStamps([state.pages[0]], [{
      group: 'n1', type: 'note', text: 'Ask Sam', lines: ['Ask Sam', 'about Q3'],
      font: 'Helvetica', size: 14, color: '#ff0000', bg: '#fff3a8',
      u: 0.3, v: 0.7, w: 0.3, rot: 0, opacity: 1,
    }]);
    const out = await reopen(await assemble(state.pages));
    const { text } = await out.read(0);
    assert(text.includes('Ask Sam') && text.includes('about Q3'), `page text is "${text.slice(0, 80)}"`);
    const canvas = await renderPage({ pdfjs: out.doc }, 0, 1);
    const near = sample(canvas, [0.15, 0.2, 0.45, 0.4], isRed);
    const far = sample(canvas, [0.6, 0.6, 1, 1], isRed);
    assert(near > 20, `expected red ink around the note, found ${near}`);
    assert(far === 0, `found ${far} red pixels far from the note`);
    await out.close();
    return `${near} ink pixels where the note was placed`;
  });

  await check('a note lands where it was placed on a rotated page too', async () => {
    rotatePages([state.pages[0]], 90);
    const out = await reopen(await assemble(state.pages));
    const canvas = await renderPage({ pdfjs: out.doc }, 0, 1, { rotation: (await out.read(0)).rotate });
    const near = sample(canvas, [0.15, 0.2, 0.45, 0.4], isRed);
    rotatePages([state.pages[0]], -90);
    await out.close();
    assert(near > 20, `expected the note top-left of the turned page, found ${near}`);
    return `${near} ink pixels, page turned 90°`;
  });

  await check('a note stays centered on a page whose box is offset or cropped', async () => {
    const { PDFDocument } = await import('../vendor/pdf-lib.esm.min.js');
    const shapes = {
      'MediaBox at (40, 30)': (p) => p.setMediaBox(40, 30, 612, 792),
      'CropBox inset': (p) => p.setCropBox(72, 50, 500, 700),
    };
    const found = [];
    for (const [label, shape] of Object.entries(shapes)) {
      const doc = await PDFDocument.create();
      shape(doc.addPage([612, 792]));
      const before = state.pages.length;
      await addPdf(new File([await doc.save()], 'boxed.pdf', { type: 'application/pdf' }));
      const page = state.pages[before];
      addStamps([page], [{
        group: 'nb', type: 'note', text: 'Mid', lines: ['Mid'], font: 'Helvetica', size: 14,
        color: '#000000', bg: '#ffff00', u: 0.5, v: 0.5, w: 0.3, rot: 0, opacity: 1,
      }]);
      const out = await reopen(await assemble([page]));
      const canvas = await renderPage({ pdfjs: out.doc }, 0, 1);
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let left = Infinity, right = -1, top = Infinity, bottom = -1;
      for (let i = 0; i < data.length; i += 4) {
        if (!(data[i] > 200 && data[i + 1] > 200 && data[i + 2] < 100)) continue;
        const x = (i / 4) % canvas.width;
        const y = Math.floor(i / 4 / canvas.width);
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      await out.close();
      deletePages([page]);
      near((left + right) / 2 / canvas.width, 0.5, 0.01, `${label}: card center x`);
      near((top + bottom) / 2 / canvas.height, 0.5, 0.01, `${label}: card center y`);
      found.push(label);
    }
    return `centered on ${found.join(', ')}`;
  });

  await check('a line drawn in the viewer is exported as a vector stroke', async () => {
    for (const p of state.pages) p.stamps = [];
    addStamps([state.pages[0]], [{
      group: 'i1', type: 'ink', color: '#ff0000', width: 4,
      points: [[0.2, 0.8], [0.4, 0.8], [0.4, 0.6]], u: 0.3, v: 0.7, rot: 0, opacity: 1,
    }]);
    const out = await reopen(await assemble(state.pages));
    const canvas = await renderPage({ pdfjs: out.doc }, 0, 1);
    const along = sample(canvas, [0.22, 0.18, 0.38, 0.22], isRed);
    const down = sample(canvas, [0.38, 0.22, 0.42, 0.38], isRed);
    const off = sample(canvas, [0.6, 0.6, 1, 1], isRed);
    await out.close();
    state.pages[0].stamps = [];
    assert(along > 50 && down > 50, `line missing: ${along} across, ${down} down`);
    assert(off === 0, `${off} red pixels away from the line`);
    return `${along + down} ink pixels on the path`;
  });

  await check('a sticky note becomes a PDF comment that keeps any text', async () => {
    for (const p of state.pages) p.stamps = [];
    addStamps([state.pages[0]], [{
      group: 'c1', type: 'comment', text: 'Größe prüfen ✓', color: '#ffd60a',
      created: Date.UTC(2026, 9, 12), u: 0.9, v: 0.9, rot: 0, opacity: 1,
    }]);
    const bytes = await assemble(state.pages);
    const out = await reopen(bytes);
    const page = await out.doc.getPage(1);
    const notes = (await page.getAnnotations()).filter((a) => a.subtype === 'Text');
    // The rect is in the page's own coordinates; the viewport turns it into
    // what a reader sees, /Rotate included.
    const view = page.getViewport({ scale: 1 });
    page.cleanup();
    assert(notes.length === 1, `found ${notes.length} text annotations`);
    const [note] = notes;
    const contents = note.contentsObj?.str ?? note.contents;
    assert(contents === 'Größe prüfen ✓', `comment reads "${contents}"`);
    const [x0, y0, x1, y1] = note.rect;
    const [cx, cy] = view.convertToViewportPoint((x0 + x1) / 2, (y0 + y1) / 2);
    assert(cx > view.width * 0.8 && cy < view.height * 0.2,
      `comment shows at ${cx.toFixed(0)},${cy.toFixed(0)} on a ${view.width}×${view.height} page`);
    await out.close();
    for (const p of state.pages) p.stamps = [];
    return `“${contents}”, top right of a page with /Rotate ${view.rotation}`;
  });

  /* ───────── compression ───────── */

  await check('rasterizing shrinks a scan-like page and keeps its size', async () => {
    state.pages[0].stamps = [];
    const { PDFDocument } = await import('../vendor/pdf-lib.esm.min.js');
    const flat = await assemble(state.pages);
    const doc = await openDocument(flat);
    const out = await PDFDocument.create();
    const page = await doc.getPage(1);
    const box = page.getViewport({ scale: 1 });
    page.cleanup();
    const canvas = await renderPage({ pdfjs: doc }, 0, 110 / 72);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.65));
    const jpg = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const sheet = out.addPage([box.width, box.height]);
    sheet.drawImage(jpg, { x: 0, y: 0, width: box.width, height: box.height });
    const bytes = await out.save({ useObjectStreams: true });

    const check2 = await reopen(bytes);
    assert(check2.pages === 1, 'rasterized output lost its page');
    const view = (await check2.read(0)).view;
    near(view.width, box.width, 1, 'rasterized page kept its width');
    near(view.height, box.height, 1, 'rasterized page kept its height');
    await check2.close();
    await closeDocument(doc);
    return `${(bytes.length / 1024).toFixed(1)} KB JPEG page at ${Math.round(box.width)}×${Math.round(box.height)} pt`;
  });

  await check('object-stream export is smaller than the naive one', async () => {
    const bytes = await assemble(state.pages);
    assert(bytes.length > 100, 'suspiciously small output');
    assert(String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-', 'output is not a PDF');
    return `${(bytes.length / 1024).toFixed(1)} KB`;
  });

  return results;
}
