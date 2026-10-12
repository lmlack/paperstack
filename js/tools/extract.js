// Text and image extraction, both straight out of PDF.js.

import { $, el, segment, download, safeName } from '../lib/dom.js';
import { pdfjs } from '../pdfjs.js';
import { state, srcOf } from '../state.js';
import { makeZip } from '../lib/zip.js';
import { withBusy, toast } from '../ui/feedback.js';

let scope = 'all';
let found = [];   // { name, bytes, url, w, h }

export function initExtract() {
  segment($('#exKind'), (v) => {
    $('#exText').hidden = v !== 'text';
    $('#exImages').hidden = v !== 'images';
  });
  segment($('#exScope'), (v) => { scope = v; });

  $('#btnExtractText').onclick = extractText;
  $('#btnCopyText').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('#exOut').value);
      toast('Copied to the clipboard.', 'ok');
    } catch {
      $('#exOut').select();
      toast('Press ⌘C / Ctrl-C to copy the selection.');
    }
  };
  $('#btnSaveText').onclick = () => download(
    new Blob([$('#exOut').value], { type: 'text/plain;charset=utf-8' }),
    `${safeName(state.outName)}.txt`,
  );

  $('#btnExtractImages').onclick = extractImages;
  $('#btnSaveImages').onclick = () => download(
    makeZip(found.map((f) => ({ name: f.name, bytes: f.bytes }))),
    `${safeName(state.outName)}-images.zip`,
  );
}

function selectedPages() {
  const chosen = state.pages.filter((p) => state.sel.has(p.uid));
  return scope === 'sel' && chosen.length ? chosen : state.pages;
}

/* ───────────────────────── text ───────────────────────── */

async function extractText() {
  const pages = selectedPages();
  const markers = $('#exMarkers').checked;

  const text = await withBusy('Reading text…', async (ui) => {
    const chunks = [];
    for (let i = 0; i < pages.length; i++) {
      ui.label(`Reading page ${i + 1} of ${pages.length}…`);
      ui.step(i, pages.length);
      const record = pages[i];
      const page = await srcOf(record).pdfjs.getPage(record.index + 1);
      const content = await page.getTextContent();
      page.cleanup();

      let body = '';
      for (const item of content.items) {
        if (item.str !== undefined) body += item.str;
        if (item.hasEOL) body += '\n';
      }
      body = body.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      chunks.push(markers ? `──── page ${state.pages.indexOf(record) + 1} ────\n${body}` : body);
    }
    return chunks.join('\n\n');
  });

  if (text === undefined) return;
  const out = $('#exOut');
  out.value = text || '';
  const empty = !text.replace(/──── page \d+ ────/g, '').trim();
  $('#btnCopyText').disabled = empty;
  $('#btnSaveText').disabled = empty;
  if (empty) {
    toast('No text layer found. This looks like a scan, so run it through OCR first.', 'err', 6500);
  } else {
    toast(`Extracted ${text.length.toLocaleString()} characters.`, 'ok');
  }
}

/* ───────────────────────── images ───────────────────────── */

async function extractImages() {
  releaseFound();
  const pages = state.pages;

  const images = await withBusy('Scanning for images…', async (ui) => {
    const out = [];
    const seen = new Set();
    let failures = 0;

    for (let i = 0; i < pages.length; i++) {
      ui.label(`Scanning page ${i + 1} of ${pages.length}…`);
      ui.step(i, pages.length);
      const record = pages[i];
      const src = srcOf(record);
      try {
        const page = await src.pdfjs.getPage(record.index + 1);
        const ops = await page.getOperatorList();
        for (let k = 0; k < ops.fnArray.length; k++) {
          if (!IMAGE_OPS.has(ops.fnArray[k])) continue;
          const objId = ops.argsArray[k][0];
          if (typeof objId !== 'string') continue;
          const key = `${src.id}:${objId}`;
          if (seen.has(key)) continue;       // the same XObject often repeats
          seen.add(key);
          try {
            const store = objId.startsWith('g_') ? src.pdfjs.commonObjs : page.objs;
            const raw = await resolveObj(store, objId);
            const file = await toPngFile(raw, `page${i + 1}-${out.length + 1}`);
            if (file) out.push(file);
          } catch { failures++; }
        }
        page.cleanup();
      } catch { failures++; }
    }
    if (failures) console.warn(`${failures} image object(s) could not be decoded.`);
    return out;
  });

  if (!images) return;
  found = images;
  renderGallery();
  toast(images.length ? `Found ${images.length} image${images.length === 1 ? '' : 's'}.`
    : 'No embedded images found.', images.length ? 'ok' : '');
}

const IMAGE_OPS = new Set([
  pdfjs.OPS.paintImageXObject,
  pdfjs.OPS.paintImageXObjectRepeat,
  pdfjs.OPS.paintInlineImageXObject,
].filter((v) => v !== undefined));

/** PDF.js hands image objects over asynchronously; wait for this one. */
function resolveObj(store, objId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`timed out on ${objId}`)); }
    }, 20_000);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      const immediate = store.get(objId, finish);
      if (immediate) finish(immediate);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

/**
 * Normalizes every shape PDF.js may hand back (an ImageBitmap on modern
 * browsers, or raw 1/24/32-bit pixel data) into a PNG blob.
 */
async function toPngFile(raw, stem) {
  if (!raw) return null;
  const width = raw.width ?? raw.bitmap?.width;
  const height = raw.height ?? raw.bitmap?.height;
  if (!width || !height || width * height < 64) return null;   // skip 8×8 spacers and masks

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (raw.bitmap) {
    ctx.drawImage(raw.bitmap, 0, 0);
  } else if (raw.data) {
    ctx.putImageData(toImageData(ctx, raw, width, height), 0, 0);
  } else {
    return null;
  }

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) return null;
  return {
    name: `${stem}-${width}x${height}.png`,
    bytes: new Uint8Array(await blob.arrayBuffer()),
    url: URL.createObjectURL(blob),
    w: width,
    h: height,
  };
}

function toImageData(ctx, raw, width, height) {
  const out = ctx.createImageData(width, height);
  const dest = out.data;
  const src = raw.data;

  // ImageKind: 1 = 1bpp gray, 2 = 24bpp RGB, 3 = 32bpp RGBA.
  if (raw.kind === 1) {
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const value = bit ? 255 : 0;
        const o = (y * width + x) * 4;
        dest[o] = dest[o + 1] = dest[o + 2] = value;
        dest[o + 3] = 255;
      }
    }
  } else if (raw.kind === 3) {
    dest.set(src.subarray(0, dest.length));
  } else {
    for (let i = 0, j = 0; i < dest.length; i += 4, j += 3) {
      dest[i] = src[j];
      dest[i + 1] = src[j + 1];
      dest[i + 2] = src[j + 2];
      dest[i + 3] = 255;
    }
  }
  return out;
}

function renderGallery() {
  const grid = $('#exImgGrid');
  grid.textContent = '';
  for (const file of found) {
    grid.append(el('div', {
      class: 'imgcell',
      title: `${file.name}, click to save`,
      onclick: () => download(new Blob([file.bytes], { type: 'image/png' }), file.name),
    },
    el('img', { src: file.url, alt: file.name, loading: 'lazy' }),
    el('span', { text: `${file.w}×${file.h}` })));
  }
  $('#btnSaveImages').hidden = found.length < 2;
}

function releaseFound() {
  for (const file of found) URL.revokeObjectURL(file.url);
  found = [];
  $('#exImgGrid').textContent = '';
  $('#btnSaveImages').hidden = true;
}
