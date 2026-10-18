// PDF.js wrapper: document loading, a thumbnail cache, and a small render queue
// so that dropping a 400-page file does not start 400 rasterizations at once.

// vendor/pdfjs holds PDF.js's *legacy* build. The modern one leans on brand-new
// built-ins (Map#getOrInsertComputed, Math.sumPrecise, ...) and fails to render
// anything in browsers even a few months old.
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';

const here = (path) => new URL(path, import.meta.url).href;

pdfjs.GlobalWorkerOptions.workerSrc = here('../vendor/pdfjs/pdf.worker.min.mjs');

const DOC_OPTS = {
  cMapUrl: here('../vendor/pdfjs/cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: here('../vendor/pdfjs/standard_fonts/'),
};

export { pdfjs };

/**
 * PDF.js takes ownership of (and may detach) the buffer it is handed, so every
 * caller gets a private copy and the pristine bytes stay with the source record.
 */
export function openDocument(bytes) {
  return pdfjs.getDocument({ ...DOC_OPTS, data: bytes.slice() }).promise;
}

/**
 * Releases a document and its worker. A PDFDocumentProxy has no destroy() of
 * its own, because the loading task owns the worker, so go through that.
 */
export async function closeDocument(doc) {
  try {
    await (doc?.loadingTask?.destroy?.() ?? doc?.destroy?.());
  } catch {
    /* already gone */
  }
}

/* ───────────────────────── render queue ───────────────────────── */

const MAX_PARALLEL = 3;
let active = 0;
const waiting = [];

function pump() {
  while (active < MAX_PARALLEL && waiting.length) {
    const job = waiting.shift();
    active++;
    job.run().then(job.resolve, job.reject).finally(() => { active--; pump(); });
  }
}

/**
 * Queues a render. An `urgent` one, the page someone is looking at in the
 * editor, starts straight away instead of waiting its turn behind a grid's
 * worth of thumbnails.
 */
function enqueue(run, urgent = false) {
  return new Promise((resolve, reject) => {
    if (urgent) {
      active++;
      run().then(resolve, reject).finally(() => { active--; pump(); });
      return;
    }
    waiting.push({ run, resolve, reject });
    pump();
  });
}

/* ───────────────────────── thumbnails ───────────────────────── */

const thumbs = new Map();   // `${srcId}:${pageIndex}:${width}` -> Promise<{canvas, wPt, hPt}>
const ready = new Map();    // the same keys, once rendered

/**
 * Renders a page at its natural orientation (PDF.js folds the page's own /Rotate
 * into the viewport) and caches the canvas. User rotation is applied afterwards
 * by {@link rotateCanvas}, which is far cheaper than re-rasterizing.
 *
 * Resolves to the canvas plus the page's display size in points, which callers
 * need to convert point-based stamp sizes into screen pixels.
 */
export function thumbnail(src, pageIndex, width = 320) {
  const key = `${src.id}:${pageIndex}:${width}`;
  if (!thumbs.has(key)) {
    thumbs.set(key, enqueue(async () => {
      const page = await src.pdfjs.getPage(pageIndex + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();
      const result = { canvas, wPt: base.width, hPt: base.height };
      ready.set(key, result);
      return result;
    }).catch((err) => { thumbs.delete(key); throw err; }));
  }
  return thumbs.get(key);
}

export function forgetThumbnails(srcId) {
  for (const key of thumbs.keys()) if (key.startsWith(`${srcId}:`)) thumbs.delete(key);
  for (const key of ready.keys()) if (key.startsWith(`${srcId}:`)) ready.delete(key);
}

/** The sharpest thumbnail already rendered for a page, or null. Never renders. */
export function peekThumbnail(src, pageIndex) {
  let best = null;
  for (const [key, result] of ready) {
    if (key.startsWith(`${src.id}:${pageIndex}:`) && (!best || result.canvas.width > best.canvas.width)) best = result;
  }
  return best;
}

/**
 * Clockwise rotation of a canvas by 0/90/180/270.
 *
 * Always returns a *new* canvas, including at 0°: the cached thumbnail is a DOM
 * node, and handing the same node to two tiles would move it out of the first
 * one rather than copy it.
 */
export function rotateCanvas(source, deg) {
  const d = ((deg % 360) + 360) % 360;
  const swap = d === 90 || d === 270;
  const out = document.createElement('canvas');
  out.width = swap ? source.height : source.width;
  out.height = swap ? source.width : source.height;
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return out;
}

/** Full-size render, used by the page editor and the compressor. */
export function renderPage(src, pageIndex, scale, { grayscale = false, rotation, urgent = false } = {}) {
  return enqueue(async () => {
    const page = await src.pdfjs.getPage(pageIndex + 1);
    const viewport = page.getViewport(rotation == null ? { scale } : { scale, rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup();
    if (grayscale) toGrayscale(ctx, canvas);
    return canvas;
  }, urgent);
}

function toGrayscale(ctx, canvas) {
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    // Rec. 709 luma, which tracks perceived brightness better than a flat average.
    const y = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) | 0;
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  ctx.putImageData(img, 0, 0);
}

export const canvasToBlob = (canvas, type, quality) =>
  new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas export failed'))), type, quality));
