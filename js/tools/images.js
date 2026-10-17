// Exporting pages as pictures. The document is written out first, exactly as
// Export PDF would, then each page of that is drawn and saved as a JPG or PNG,
// so every watermark, signature and note is in the picture. Sticky notes are
// comments rather than ink, so they stay out, as they do when a PDF prints.

import { download, safeName } from '../lib/dom.js';
import { state, targetPages } from '../state.js';
import { assemble } from '../assemble.js';
import { openDocument, closeDocument, canvasToBlob } from '../pdfjs.js';
import { makeZip } from '../lib/zip.js';
import { withBusy, toast } from '../ui/feedback.js';

const DPI = 150;                 // sharp on screen and fine for printing a page
const MAX_EDGE = 5000;           // keeps a poster-sized page within memory
const FORMATS = {
  jpg: { mime: 'image/jpeg', quality: 0.9 },
  png: { mime: 'image/png' },
};

/** What an image export would cover, for the menu: the selection, or every page. */
export function imageScope() {
  const n = targetPages().length;
  return state.sel.size ? `The ${n} selected page${n === 1 ? '' : 's'}` : `All ${n} page${n === 1 ? '' : 's'}, one image each`;
}

export async function exportImages(kind) {
  const { mime, quality } = FORMATS[kind];
  const pages = targetPages();
  const numbers = pages.map((p) => state.pages.indexOf(p) + 1);
  const stem = safeName(state.outName);
  const pad = String(state.pages.length).length;

  await withBusy('Writing images…', async (ui) => {
    const bytes = await assemble(pages, (done, total) => {
      ui.label(`Preparing page ${done} of ${total}…`);
      ui.step(done, total * 2);
    });
    const doc = await openDocument(bytes);
    const files = [];
    try {
      for (let i = 0; i < pages.length; i++) {
        ui.label(`Drawing page ${numbers[i]}…`);
        ui.step(pages.length + i, pages.length * 2);
        const page = await doc.getPage(i + 1);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(DPI / 72, MAX_EDGE / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#fff';   // JPG has no transparency, and a PNG page should be paper too
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        page.cleanup();
        const blob = await canvasToBlob(canvas, mime, quality);
        files.push({
          name: `${stem}-page-${String(numbers[i]).padStart(pad, '0')}.${kind}`,
          bytes: new Uint8Array(await blob.arrayBuffer()),
        });
        canvas.width = canvas.height = 0;
      }
    } finally {
      void closeDocument(doc);
    }

    if (files.length === 1) {
      download(new Blob([files[0].bytes], { type: mime }), files[0].name);
      toast(`Saved ${files[0].name}`, 'ok');
    } else {
      download(makeZip(files), `${stem}-${kind}.zip`);
      toast(`Saved ${files.length} images as a zip.`, 'ok');
    }
  });
}
