// Two honest compression strategies:
//   "Optimize":    rewrite the file with object streams, and text stays text.
//   "Shrink hard": redraw every page as a JPEG at a chosen resolution.

import { PDFDocument } from '../../vendor/pdf-lib.esm.min.js';
import { $, el, segment, bindRange, fmtBytes, download, safeName } from '../lib/dom.js';
import { openDocument, closeDocument, renderPage, canvasToBlob } from '../pdfjs.js';
import { state, on, totalBytes, replaceWith } from '../state.js';
import { assemble, addComment } from '../assemble.js';
import { withBusy, toast } from '../ui/feedback.js';

const PRESETS = {
  high:     { dpi: 150, q: 82 },
  balanced: { dpi: 110, q: 65 },
  small:    { dpi: 72,  q: 48 },
};

const HINTS = {
  lossless: 'Rewrites the file structure and drops objects nothing points at. Text stays selectable. '
    + 'Helps most on files that have been edited and re-saved many times. A new PDF may not shrink at all.',
  raster: 'Redraws each page as a JPEG. Works best on scans and image-heavy files.',
};

let mode = 'lossless';

export function initCompress() {
  const dpi = $('#cmpDpi');
  const quality = $('#cmpQ');
  const preset = segment($('#cmpPreset'), (v) => {
    dpi.value = PRESETS[v].dpi;
    quality.value = PRESETS[v].q;
    dpi.dispatchEvent(new Event('input'));
    quality.dispatchEvent(new Event('input'));
  });

  bindRange(dpi, $('#dpiOut'), (v) => `${v} dpi`);
  bindRange(quality, $('#qOut'), (v) => `${v}%`);

  // Nudging a slider by hand means you are no longer on a preset.
  const clearPreset = () => {
    const match = Object.entries(PRESETS)
      .find(([, p]) => p.dpi === Number(dpi.value) && p.q === Number(quality.value));
    preset.value = match ? match[0] : '';
  };
  dpi.addEventListener('input', clearPreset);
  quality.addEventListener('input', clearPreset);

  segment($('#cmpMode'), (v) => {
    mode = v;
    $('#cmpRasterOpts').hidden = v !== 'raster';
    $('#cmpModeHint').textContent = HINTS[v];
  });

  $('#btnCompress').onclick = run;
  on('pages', () => { $('#cmpResult').hidden = true; });
}

async function run() {
  const before = totalBytes();
  const result = await withBusy('Compressing…', async (ui) => {
    const bytes = mode === 'raster'
      ? await rasterize(Number($('#cmpDpi').value), Number($('#cmpQ').value) / 100, $('#cmpGray').checked, ui)
      : await assemble(state.pages, (done, total) => {
        ui.label(`Rewriting page ${done} of ${total}…`);
        ui.step(done, total);
      });
    return bytes;
  });
  if (!result) return;

  // Rewriting a lean PDF can easily make it bigger. If the file came in
  // untouched and we cannot beat it, hand the original back instead of
  // dressing up a loss as a result.
  if (mode === 'lossless' && result.length >= before && pristine()) {
    showAlreadyOptimal(before);
    return;
  }
  showResult(before, result);
}

/** True when the workspace is still exactly one unmodified source file. */
function pristine() {
  if (state.sources.size !== 1) return false;
  const src = [...state.sources.values()][0];
  return state.pages.length === src.pageCount
    && state.pages.every((p, i) => p.index === i && p.rot === 0 && p.stamps.length === 0);
}

function showAlreadyOptimal(before) {
  const src = [...state.sources.values()][0];
  const host = $('#cmpResult');
  host.hidden = false;
  host.textContent = '';
  host.append(
    el('span', { class: 'big', style: 'color:var(--ink)', text: 'Already as small as it gets' }),
    el('span', { class: 'cmp', style: 'font-family:inherit', text: `${fmtBytes(before)}. Rewriting it would make it larger.` }),
    el('p', { class: 'hint',
      text: 'There is nothing to remove from this file, so the original is already the smallest lossless version. '
        + 'If you need it smaller, switch to “Shrink hard”.' }),
    el('button', {
      class: 'btn block',
      text: 'Download the original unchanged',
      onclick: () => download(new Blob([src.bytes], { type: 'application/pdf' }), src.name),
    }),
  );
}

/**
 * Assembles the current workspace first (so page order, rotation and stamps are
 * baked in), then re-draws every page of that document as a JPEG.
 */
async function rasterize(dpi, quality, grayscale, ui) {
  ui.label('Preparing pages…');
  const flattened = await assemble(state.pages);
  const doc = await openDocument(flattened);
  const fakeSource = { pdfjs: doc };
  const out = await PDFDocument.create();
  out.setProducer('Paperstack');

  const scale = dpi / 72;
  for (let i = 0; i < doc.numPages; i++) {
    ui.label(`Re-drawing page ${i + 1} of ${doc.numPages}…`);
    ui.step(i, doc.numPages);

    const page = await doc.getPage(i + 1);
    const pointSize = page.getViewport({ scale: 1 });
    page.cleanup();

    const canvas = await renderPage(fakeSource, i, scale, { grayscale });
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    const jpg = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const sheet = out.addPage([pointSize.width, pointSize.height]);
    sheet.drawImage(jpg, { x: 0, y: 0, width: pointSize.width, height: pointSize.height });
    // Sticky notes are annotations, not ink, so the redraw would drop them.
    // The redrawn page is upright at its displayed size, so no rotation applies.
    for (const stamp of state.pages[i].stamps) {
      if (stamp.type === 'comment') addComment(out, sheet, stamp, { W: pointSize.width, H: pointSize.height, rot: 0 });
    }

    canvas.width = canvas.height = 0;   // let the bitmap go early on long documents
  }
  const pageCount = doc.numPages;
  await closeDocument(doc);
  ui.step(pageCount, pageCount);
  return out.save({ useObjectStreams: true });
}

function showResult(before, bytes) {
  const after = bytes.length;
  const saved = before - after;
  const pct = before ? Math.round((saved / before) * 100) : 0;
  const host = $('#cmpResult');
  host.hidden = false;
  host.textContent = '';

  host.append(
    el('span', {
      class: 'big',
      style: saved > 0 ? '' : 'color:var(--ink)',
      text: saved > 0 ? `${pct}% smaller` : 'Not any smaller',
    }),
    el('span', { class: 'cmp', text: `${fmtBytes(before)} → ${fmtBytes(after)}` }),
  );
  if (saved <= 0) {
    host.append(el('p', { class: 'hint',
      text: 'This file is already compact. Try “Shrink hard” if the pages are scans or photos.' }));
  }

  const name = `${safeName(state.outName)}-compressed.pdf`;
  host.append(el('div', { class: 'field-row' },
    el('button', {
      class: 'btn primary block',
      text: 'Download',
      onclick: () => download(new Blob([bytes], { type: 'application/pdf' }), name),
    }),
    el('button', {
      class: 'btn block',
      text: 'Keep editing this',
      onclick: () => withBusy('Loading compressed file…', async () => {
        await replaceWith(name, bytes);
        toast('Workspace replaced with the compressed document.', 'ok');
      }),
    })));
}
