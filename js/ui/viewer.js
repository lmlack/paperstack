// The page editor: one page at a time, full size, rendered at the zoom you ask
// for, with the queued stamps drawn on top so you see what you will export.
// Everything that changes a single page happens here: select and move marks
// (arrange.js), draw, type and leave sticky notes (markup.js), sign (sign.js
// wires its button), rotate or delete the page, and undo any of it.

import { $ } from '../lib/dom.js';
import { renderPage, peekThumbnail, rotateCanvas } from '../pdfjs.js';
import { displayInfo } from '../assemble.js';
import { state, on, srcOf, rotatePages, deletePages, liveSources } from '../state.js';
import { paintStamps } from './stamps.js';
import { toast } from './feedback.js';
import { undoable, historyKey } from './history.js';
import { initMarkup, setMode, markupMode, finishText, cancelStroke } from './markup.js';
import { initArrange, pick, pickedId, deletePicked, decorate } from './arrange.js';

const ZOOM_STEPS = [0.25, 0.4, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4];
const MAX_CANVAS_EDGE = 5000;   // keeps a 400% zoom on A0 from exhausting memory

const viewer = $('#viewer');
const stage = $('#viewerStage');
const sheet = $('#viewerSheet');
const canvas = $('#viewerCanvas');
const stamps = $('#viewerStamps');

let currentUid = null;
let mode = 'fit';      // 'fit' | 'width' | a number
let renderToken = 0;
let shown = null;      // what the canvas holds: { key, page, wPt, hPt, scale }
let pickAfterDraw = null;   // a mark to select once the page has rendered
let backPending = false;    // closed, and the history.back() has not landed yet

// Anything that changes the rendered page itself, as opposed to its stamps.
const renderKey = (page) => `${page.uid}|${page.srcId}|${page.index}|${page.rot}`;

const HISTORY_KEY = 'paperstackViewer';
const isOpen = () => !viewer.hidden;
const indexOf = () => state.pages.findIndex((p) => p.uid === currentUid);

export function initViewer() {
  $('#viewPrev').onclick = () => step(-1);
  $('#viewNext').onclick = () => step(1);
  $('#viewClose').onclick = closeViewer;
  $('#viewBack').onclick = closeViewer;
  $('#viewZoomIn').onclick = () => nudgeZoom(1);
  $('#viewZoomOut').onclick = () => nudgeZoom(-1);
  $('#viewFit').onclick = () => { mode = mode === 'fit' ? 'width' : 'fit'; draw(); };
  wireTouchZoom();
  wireSwipe();
  $('#viewRotL').onclick = () => withPage((page) => rotatePages([page], -90));
  $('#viewRotR').onclick = () => withPage((page) => rotatePages([page], 90));
  const current = () => (shown && shown.page === state.pages[indexOf()] ? shown : null);
  initMarkup(current);
  initArrange(current, () => markupMode() === 'select');
  $('#viewDelete').onclick = () => withPage((page) => {
    if (state.pages.length === 1) {
      toast('That would delete the last page.', 'err');
      return;
    }
    const number = indexOf() + 1;
    const next = state.pages[indexOf() + 1] ?? state.pages[indexOf() - 1];
    currentUid = next?.uid ?? null;
    deletePages([page]);
    undoable(`Deleted page ${number}.`);
  });

  document.addEventListener('keydown', onKey);
  // Start over: the cached renders belong to files that are gone.
  on('sources', () => { if (!state.pages.length) renders.clear(); });

  // The viewer takes a history entry, so a phone's back gesture or the
  // browser's back button closes it rather than leaving the app.
  window.addEventListener('popstate', () => {
    // Our own history.back() from closing. If a page was opened again before
    // it landed, the editor is showing and needs its entry back.
    if (backPending) {
      backPending = false;
      if (isOpen()) history.pushState({ [HISTORY_KEY]: true }, '');
      return;
    }
    if (isOpen() && !history.state?.[HISTORY_KEY]) closeViewer();
  });

  // Only a real change in the room the page has calls for a new render;
  // phones fire resize for small things, like a toolbar sliding away.
  let resizeTimer = 0;
  let room = '';
  window.addEventListener('resize', () => {
    if (!isOpen()) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const now = `${stage.clientWidth}x${stage.clientHeight}`;
      if (now !== room) { room = now; draw(); }
    }, 120);
  });

  // Rotation, deletion or a re-order elsewhere should be reflected here too.
  // A new or removed mark only needs the stamps repainted, which keeps drawing
  // from re-rendering the page under the pen after every stroke.
  on('pages', () => {
    if (!isOpen()) return;
    const page = state.pages[indexOf()];
    if (!page) { closeViewer(); return; }
    if (shown && !viewer.classList.contains('busy') && shown.key === renderKey(page)) {
      // Undo can swap in a fresh copy of the same page; follow it.
      shown.page = page;
      paintStamps(stamps, page, shown.wPt);
      decorate();
      $('#viewCount').textContent = `Page ${indexOf() + 1} of ${state.pages.length}`;
      $('#viewPrev').disabled = indexOf() === 0;
      $('#viewNext').disabled = indexOf() === state.pages.length - 1;
      return;
    }
    draw();
  });
}

/** The page open in the editor, or null when it is closed. */
export const currentPage = () => (isOpen() ? state.pages[indexOf()] ?? null : null);

/**
 * The middle of the part of the page you can see, as page fractions (v up),
 * so something new lands in view even when zoomed in.
 */
export function visibleCenter() {
  const a = stage.getBoundingClientRect();
  const b = sheet.getBoundingClientRect();
  const x0 = Math.max(a.left, b.left);
  const x1 = Math.min(a.right, b.right);
  const y0 = Math.max(a.top, b.top);
  const y1 = Math.min(a.bottom, b.bottom);
  if (x1 <= x0 || y1 <= y0 || !b.width) return { u: 0.5, v: 0.5 };
  return { u: ((x0 + x1) / 2 - b.left) / b.width, v: 1 - ((y0 + y1) / 2 - b.top) / b.height };
}

/** Selects a mark on the open page, switching to the Select tool. */
export function selectMark(id) {
  setMode('select');
  pick(id);
}

function withPage(fn) {
  const page = state.pages[indexOf()];
  if (page) fn(page);
}

/**
 * Opens the editor on a page. With `pick`, that mark is selected once the page
 * is showing, ready to be dragged into place.
 */
export function openViewer(uid, { pick: id = null } = {}) {
  const page = state.pages.find((p) => p.uid === uid);
  if (!page) return;
  const same = isOpen() && currentUid === uid;
  currentUid = uid;
  setMode('select');
  if (same && shown) { pick(id); return; }
  pick(null);
  pickAfterDraw = id;
  mode = 'fit';
  if (!isOpen() && !backPending && !history.state?.[HISTORY_KEY]) history.pushState({ [HISTORY_KEY]: true }, '');
  viewer.hidden = false;
  draw();
}

export function closeViewer() {
  if (!isOpen()) return;
  finishText();
  setMode('select');
  pick(null);
  viewer.hidden = true;
  // Closed by the button, Esc or a deletion: take back the entry we added.
  // Closed by going back: it is already gone.
  if (history.state?.[HISTORY_KEY]) { backPending = true; history.back(); }
  currentUid = null;
  shown = null;
  renderToken++;                       // abandon any render still in flight
  canvas.width = canvas.height = 0;
  stamps.textContent = '';
}

function step(delta) {
  const next = indexOf() + delta;
  if (next < 0 || next >= state.pages.length) return;
  finishText();
  pick(null);
  currentUid = state.pages[next].uid;
  draw();
}

/** Steps to the next preset zoom, holding at either end rather than wrapping. */
function nudgeZoom(direction) {
  const current = typeof mode === 'number' ? mode : lastScale;
  const next = direction > 0
    ? ZOOM_STEPS.find((z) => z > current + 1e-6) ?? ZOOM_STEPS.at(-1)
    : ZOOM_STEPS.findLast((z) => z < current - 1e-6) ?? ZOOM_STEPS[0];
  if (next === current) return;
  mode = next;
  draw();
}

/** Undo while typing would act on the page under the box; drop the box first. */
function finishTextOnHistory(e) {
  if ((e.metaKey || e.ctrlKey) && /^[zy]$/i.test(e.key)) finishText(false);
}

function onKey(e) {
  if (!isOpen()) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;

  if (!$('#signDialog').hidden) return;
  finishTextOnHistory(e);
  if (historyKey(e)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const toggle = (m) => () => setMode(markupMode() === m ? 'select' : m);
  const keys = {
    // Esc lets go of a picked mark, then leaves a tool, and only then closes.
    Escape: () => {
      if (pickedId()) pick(null);
      else if (markupMode() !== 'select') setMode('select');
      else closeViewer();
    },
    Delete: () => deletePicked(),
    Backspace: () => deletePicked(),
    v: () => setMode('select'),
    d: toggle('draw'),
    t: toggle('type'),
    n: toggle('note'),
    s: () => $('#viewSign').click(),
    ArrowRight: () => step(1),
    ArrowLeft: () => step(-1),
    PageDown: () => step(1),
    PageUp: () => step(-1),
    '+': () => nudgeZoom(1),
    '=': () => nudgeZoom(1),
    '-': () => nudgeZoom(-1),
    '0': () => { mode = 'fit'; draw(); },
    '[': () => withPage((page) => rotatePages([page], -90)),
    ']': () => withPage((page) => rotatePages([page], 90)),
  };
  const action = keys[e.key];
  if (!action) return;
  e.preventDefault();
  e.stopPropagation();
  action();
}

let lastScale = 1;

const clampZoom = (z) => Math.max(ZOOM_STEPS[0], Math.min(ZOOM_STEPS.at(-1), z));

/**
 * Zooms to `scale`, keeping the point of the page under `anchor` (client
 * pixels) where it is, so a pinch or double-tap zooms into what was touched.
 */
async function zoomAround(scale, anchor) {
  const before = sheet.getBoundingClientRect();
  const fx = (anchor.x - before.left) / before.width;
  const fy = (anchor.y - before.top) / before.height;
  mode = clampZoom(scale);
  await draw();
  const after = sheet.getBoundingClientRect();
  stage.scrollLeft += after.left + fx * after.width - anchor.x;
  stage.scrollTop += after.top + fy * after.height - anchor.y;
}

/**
 * Touch screens. A pinch zooms the page, not the whole app: the browser's own
 * zoom took the toolbars with it and was hard to get back out of. A double
 * tap on the page toggles between the whole page and a closer look.
 */
function wireTouchZoom() {
  let pinch = null;   // { dist, scale, origin, k }
  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const middle = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2 || !shown) return;
    cancelStroke();
    finishText(false);
    const box = sheet.getBoundingClientRect();
    const mid = middle(e.touches);
    sheet.style.transformOrigin = `${mid.x - box.left}px ${mid.y - box.top}px`;
    pinch = { dist: spread(e.touches), scale: shown.scale, origin: mid, k: 1 };
  }, { passive: true });

  stage.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    // Stretch the page as it is while the fingers move; render once they lift.
    pinch.k = clampZoom(pinch.scale * (spread(e.touches) / pinch.dist)) / pinch.scale;
    sheet.style.transform = `scale(${pinch.k})`;
  }, { passive: false });

  const end = (e) => {
    if (!pinch || e.touches.length >= 2) return;
    const { k, scale, origin } = pinch;
    pinch = null;
    sheet.style.transform = '';
    if (Math.abs(k - 1) > 0.03) zoomAround(scale * k, origin);
  };
  stage.addEventListener('touchend', end);
  stage.addEventListener('touchcancel', end);

  // Safari's own pinch gesture, which touch-action alone does not always stop.
  viewer.addEventListener('gesturestart', (e) => e.preventDefault());

  stage.addEventListener('dblclick', (e) => {
    if (markupMode() !== 'select' || e.target.closest('[data-id]') || !shown) return;
    if (mode === 'fit') zoomAround(Math.max(shown.scale * 2, 1), { x: e.clientX, y: e.clientY });
    else { mode = 'fit'; draw(); }
  });
}

/**
 * A one-finger swipe across the page turns to the next or previous one, with
 * the page following the finger. Only in Select, where a touch has nothing
 * else to do, and not from a mark, which is a drag. Zoomed in, the page
 * scrolls first and turns only from its edge.
 */
function wireSwipe() {
  const TURN = 0.22;   // of the stage's width, to count as a swipe
  let swipe = null;    // { x, y, t, dir, live }

  const atEdge = (dir) => (dir < 0
    ? stage.scrollLeft + stage.clientWidth >= stage.scrollWidth - 2   // going forward: at the right edge
    : stage.scrollLeft <= 2);

  stage.addEventListener('touchstart', (e) => {
    swipe = null;
    if (e.touches.length !== 1 || markupMode() !== 'select' || e.target.closest('[data-id]') || !shown) return;
    const t = e.touches[0];
    swipe = { x: t.clientX, y: t.clientY, t: performance.now(), dir: 0, live: false };
  }, { passive: true });

  stage.addEventListener('touchmove', (e) => {
    if (!swipe) return;
    if (e.touches.length !== 1) { settle(false); return; }
    const t = e.touches[0];
    const dx = t.clientX - swipe.x;
    const dy = t.clientY - swipe.y;
    if (!swipe.live) {
      if (Math.hypot(dx, dy) < 10) return;
      // Mostly sideways, and nothing left to scroll that way: it is ours.
      if (Math.abs(dx) < Math.abs(dy) * 1.5 || !atEdge(Math.sign(dx))) { swipe = null; return; }
      swipe.live = true;
      sheet.style.transition = 'none';
    }
    e.preventDefault();
    swipe.dir = Math.sign(dx);
    // Resist past the first and last page.
    const blocked = (dx > 0 && indexOf() === 0) || (dx < 0 && indexOf() === state.pages.length - 1);
    sheet.style.translate = `${blocked ? dx / 4 : dx}px 0`;
    sheet.style.opacity = String(1 - Math.min(0.5, Math.abs(dx) / stage.clientWidth));
  }, { passive: false });

  const settle = (turn) => {
    const dir = swipe?.dir ?? 0;
    swipe = null;
    sheet.style.transition = 'translate .18s ease-out, opacity .18s ease-out';
    sheet.style.translate = '';
    sheet.style.opacity = '';
    if (turn) step(-dir);
  };

  stage.addEventListener('touchend', (e) => {
    if (!swipe?.live) { swipe = null; return; }
    const t = e.changedTouches[0];
    const dx = t.clientX - swipe.x;
    const fast = Math.abs(dx) / (performance.now() - swipe.t) > 0.5;   // a flick, px per ms
    settle(Math.abs(dx) > stage.clientWidth * TURN || (fast && Math.abs(dx) > 40));
  });
  stage.addEventListener('touchcancel', () => { if (swipe?.live) settle(false); else swipe = null; });
}

/* ───────────────────────── rendering ───────────────────────── */

// Recent renders, newest last, so paging back and forth or reopening a page
// is instant. Each is a few megabytes, so only a handful are kept.
const CACHE_SIZE = 6;
const renders = new Map();   // `${renderKey}|${pixelScale}` -> Promise<canvas>

/** How a page will be drawn at the current zoom: its size, scale and bitmap scale. */
async function layoutFor(page) {
  const { w: wPt, h: hPt, rotation } = await displayInfo(page);
  const room = { w: stage.clientWidth - 52, h: stage.clientHeight - 52 };
  const fit = Math.min(room.w / wPt, room.h / hPt);
  const scale = mode === 'fit' ? fit : mode === 'width' ? room.w / wPt : mode;
  // Render above CSS size for a crisp page, but cap the bitmap.
  const density = Math.min(window.devicePixelRatio || 1, 2);
  const pixelScale = Math.min(scale * density, MAX_CANVAS_EDGE / Math.max(wPt, hPt));
  return { wPt, hPt, rotation, scale, pixelScale };
}

/** The page rendered at `layout`, from the cache when it is there. */
function renderFor(page, layout) {
  const key = `${renderKey(page)}|${layout.pixelScale.toFixed(4)}`;
  let job = renders.get(key);
  if (job) {
    renders.delete(key);   // move to the newest end
  } else {
    job = renderPage(srcOf(page), page.index, layout.pixelScale, { rotation: layout.rotation, urgent: true });
    job.catch(() => renders.delete(key));
  }
  renders.set(key, job);
  while (renders.size > CACHE_SIZE) renders.delete(renders.keys().next().value);
  return job;
}

const isCached = (page, layout) => renders.has(`${renderKey(page)}|${layout.pixelScale.toFixed(4)}`);

function paint(image, width, height) {
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
}

/** Gets the pages either side ready, so a swipe or an arrow key lands on a finished page. */
async function prefetch(index) {
  for (const near of [index + 1, index - 1]) {
    const page = state.pages[near];
    if (!page) continue;
    try {
      const layout = await layoutFor(page);
      if (!isCached(page, layout)) await renderFor(page, layout);
    } catch { /* it will be rendered properly if it is opened */ }
  }
}

async function draw() {
  const index = indexOf();
  const page = state.pages[index];
  if (!page) return;

  finishText();
  const token = ++renderToken;
  shown = null;
  viewer.classList.add('busy');

  $('#viewCount').textContent = `Page ${index + 1} of ${state.pages.length}`;
  $('#viewTitle').textContent = liveSources().length > 1 ? srcOf(page).name : '';
  $('#viewPrev').disabled = index === 0;
  $('#viewNext').disabled = index === state.pages.length - 1;

  try {
    const layout = await layoutFor(page);
    if (token !== renderToken) return;
    const { wPt, hPt, scale, pixelScale } = layout;
    lastScale = scale;
    sheet.style.width = `${Math.round(wPt * scale)}px`;
    sheet.style.height = `${Math.round(hPt * scale)}px`;

    // Until the sharp render is ready, show the thumbnail the grid already
    // made, stretched to size: the page appears at once and sharpens a
    // moment later, instead of a blank sheet.
    if (!isCached(page, layout)) {
      const thumb = peekThumbnail(srcOf(page), page.index);
      if (thumb) paint(rotateCanvas(thumb.canvas, page.rot), wPt * pixelScale, hPt * pixelScale);
      else paint(document.createElement('canvas'), 1, 1);
      paintStamps(stamps, page, wPt);
    }

    const rendered = await renderFor(page, layout);
    if (token !== renderToken) return;

    paint(rendered, rendered.width, rendered.height);
    paintStamps(stamps, page, wPt);
    shown = { key: renderKey(page), page, wPt, hPt, scale };
    if (pickAfterDraw) { pick(pickAfterDraw); pickAfterDraw = null; } else decorate();
    $('#viewZoom').textContent = `${Math.round(scale * 100)}%`;
    // From any zoom but the whole page, this is the way back to it.
    $('#viewFit').textContent = mode === 'fit' ? 'Fit width' : 'Fit page';
    $('#viewZoomIn').disabled = scale >= ZOOM_STEPS.at(-1) - 1e-6;
    $('#viewZoomOut').disabled = scale <= ZOOM_STEPS[0] + 1e-6;
    // lets anything watching (including the tests) know the render settled
    sheet.dataset.page = page.uid;
    sheet.dataset.scale = scale.toFixed(3);
    viewer.classList.remove('busy');
    prefetch(index);
  } catch (err) {
    console.error(err);
    toast('That page could not be rendered.', 'err');
  } finally {
    if (token === renderToken) viewer.classList.remove('busy');
  }
}
