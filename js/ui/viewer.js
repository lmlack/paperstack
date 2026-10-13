// Full-size page viewer: one page at a time, rendered at the zoom you ask for,
// with the queued stamps drawn on top so you see what you will export.

import { $, el } from '../lib/dom.js';
import { renderPage } from '../pdfjs.js';
import { displayInfo } from '../assemble.js';
import { state, on, srcOf, rotatePages, deletePages } from '../state.js';
import { paintStamps } from './stamps.js';
import { toast } from './feedback.js';

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

const HISTORY_KEY = 'paperstackViewer';
const isOpen = () => !viewer.hidden;
const indexOf = () => state.pages.findIndex((p) => p.uid === currentUid);

export function initViewer() {
  $('#viewPrev').onclick = () => step(-1);
  $('#viewNext').onclick = () => step(1);
  $('#viewClose').onclick = closeViewer;
  $('#viewZoomIn').onclick = () => nudgeZoom(1);
  $('#viewZoomOut').onclick = () => nudgeZoom(-1);
  $('#viewFit').onclick = () => { mode = mode === 'fit' ? 'width' : 'fit'; draw(); };
  $('#viewRotL').onclick = () => withPage((page) => rotatePages([page], -90));
  $('#viewRotR').onclick = () => withPage((page) => rotatePages([page], 90));
  $('#viewDelete').onclick = () => withPage((page) => {
    if (state.pages.length === 1) {
      toast('That would delete the last page.', 'err');
      return;
    }
    const next = state.pages[indexOf() + 1] ?? state.pages[indexOf() - 1];
    currentUid = next?.uid ?? null;
    deletePages([page]);
  });

  document.addEventListener('keydown', onKey);

  // The viewer takes a history entry, so a phone's back gesture or the
  // browser's back button closes it rather than leaving the app.
  window.addEventListener('popstate', () => {
    if (isOpen() && !history.state?.[HISTORY_KEY]) closeViewer();
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (!isOpen()) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 120);
  });

  // Rotation, deletion or a re-order elsewhere should be reflected here too.
  on('pages', () => {
    if (!isOpen()) return;
    if (indexOf() < 0) { closeViewer(); return; }
    draw();
  });
}

function withPage(fn) {
  const page = state.pages[indexOf()];
  if (page) fn(page);
}

export function openViewer(uid) {
  const page = state.pages.find((p) => p.uid === uid);
  if (!page) return;
  currentUid = uid;
  mode = 'fit';
  if (!isOpen() && !history.state?.[HISTORY_KEY]) history.pushState({ [HISTORY_KEY]: true }, '');
  viewer.hidden = false;
  draw();
}

export function closeViewer() {
  if (!isOpen()) return;
  viewer.hidden = true;
  // Closed by the button, Esc or a deletion: take back the entry we added.
  // Closed by going back: it is already gone.
  if (history.state?.[HISTORY_KEY]) history.back();
  currentUid = null;
  renderToken++;                       // abandon any render still in flight
  canvas.width = canvas.height = 0;
  stamps.textContent = '';
}

function step(delta) {
  const next = indexOf() + delta;
  if (next < 0 || next >= state.pages.length) return;
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

function onKey(e) {
  if (!isOpen()) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;

  const keys = {
    Escape: closeViewer,
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

async function draw() {
  const index = indexOf();
  const page = state.pages[index];
  if (!page) return;

  const token = ++renderToken;
  viewer.classList.add('busy');

  $('#viewCount').textContent = `Page ${index + 1} of ${state.pages.length}`;
  $('#viewTitle').textContent = state.sources.size > 1 ? srcOf(page).name : '';
  $('#viewPrev').disabled = index === 0;
  $('#viewNext').disabled = index === state.pages.length - 1;

  try {
    const { w: wPt, h: hPt, rotation } = await displayInfo(page);
    if (token !== renderToken) return;

    const room = { w: stage.clientWidth - 52, h: stage.clientHeight - 52 };
    const fit = Math.min(room.w / wPt, room.h / hPt);
    const scale = mode === 'fit' ? fit : mode === 'width' ? room.w / wPt : mode;
    lastScale = scale;

    // Render above CSS size for a crisp page, but cap the bitmap.
    const density = Math.min(window.devicePixelRatio || 1, 2);
    const pixelScale = Math.min(scale * density, MAX_CANVAS_EDGE / Math.max(wPt, hPt));

    const rendered = await renderPage(srcOf(page), page.index, pixelScale, { rotation });
    if (token !== renderToken) return;

    canvas.width = rendered.width;
    canvas.height = rendered.height;
    canvas.getContext('2d').drawImage(rendered, 0, 0);
    sheet.style.width = `${Math.round(wPt * scale)}px`;
    sheet.style.height = `${Math.round(hPt * scale)}px`;

    paintStamps(stamps, page, wPt);
    $('#viewZoom').textContent = `${Math.round(scale * 100)}%`;
    $('#viewFit').textContent = mode === 'width' ? 'Fit page' : 'Fit width';
    $('#viewZoomIn').disabled = scale >= ZOOM_STEPS.at(-1) - 1e-6;
    $('#viewZoomOut').disabled = scale <= ZOOM_STEPS[0] + 1e-6;
    // lets anything watching (including the tests) know the render settled
    sheet.dataset.page = page.uid;
    sheet.dataset.scale = scale.toFixed(3);
  } catch (err) {
    console.error(err);
    toast('That page could not be rendered.', 'err');
  } finally {
    if (token === renderToken) viewer.classList.remove('busy');
  }
}
