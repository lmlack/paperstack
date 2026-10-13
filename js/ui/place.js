// The "drag it into place" window: one page drawn full size, with an item on
// top that can be moved and, if it allows, resized from its corner. Signatures
// and notes both use it; each one supplies what the item looks like.

import { $ } from '../lib/dom.js';
import { state } from '../state.js';
import { renderPage } from '../pdfjs.js';
import { displayInfo } from '../assemble.js';
import { withBusy } from './feedback.js';

const STAGE_MAX = { w: 780, h: 460 };

const modal = $('#placeModal');
const stage = $('#placeStage');
const item = $('#placeItem');
const grip = $('.grip', item);

let current = null;   // { stageW, stageH, resize, finish }

export function initPlacement() {
  $('#placeClose').onclick = () => finish(null);
  $('#placeCancel').onclick = () => finish(null);
  $('#placeConfirm').onclick = () => finish(geometry());
  modal.addEventListener('pointerdown', (e) => { if (e.target === modal) finish(null); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) finish(null);
  });
  makeDraggable();
}

/**
 * Opens the window on `page` and resolves with where the item ended up, or
 * null if the user backed out.
 *
 * `build(item, stage)` fills the item and sets its starting size and position
 * in stage pixels. `stage.scale` is pixels per point. It may return
 * `{ resize(width) }` to make the corner grip live; without it there is none.
 *
 * @returns {Promise<null | {u:number, v:number, w:number}>}
 *   u, v: the item's center as fractions of the page, y up; w: its width as a
 *   fraction of the page width.
 */
export async function place(page, { title, confirm, hint, build }) {
  let opened = false;
  const result = new Promise((resolve) => {
    current = { finish: resolve };
  });

  await withBusy('Rendering page…', async () => {
    const { w: wPt, h: hPt, rotation } = await displayInfo(page);
    const scale = Math.min(STAGE_MAX.w / wPt, STAGE_MAX.h / hPt, 2);
    const canvas = await renderPage(state.sources.get(page.srcId), page.index, scale, { rotation });

    const target = $('#placeCanvas');
    target.width = canvas.width;
    target.height = canvas.height;
    target.getContext('2d').drawImage(canvas, 0, 0);
    stage.style.width = `${canvas.width}px`;
    stage.style.height = `${canvas.height}px`;

    $('#placeTitle').textContent = title;
    $('#placeConfirm').textContent = confirm;
    item.replaceChildren(grip);
    item.removeAttribute('style');
    item.className = 'place-item';
    const { resize } = build(item, { w: canvas.width, h: canvas.height, scale }) ?? {};
    grip.hidden = !resize;
    $('#placeHint').textContent = hint ?? (resize
      ? 'Drag to move, or grab the corner to resize'
      : 'Drag to move');

    Object.assign(current, { stageW: canvas.width, stageH: canvas.height, resize });
    modal.hidden = false;
    clamp();   // sizes are only real once the window is showing
    opened = true;
  });

  if (!opened) finish(null);   // rendering failed; withBusy has said why
  return result;
}

function geometry() {
  if (!current) return null;
  const width = item.offsetWidth;
  const height = item.offsetHeight;
  return {
    u: (item.offsetLeft + width / 2) / current.stageW,
    v: 1 - (item.offsetTop + height / 2) / current.stageH,   // stage is y-down, PDFs are y-up
    w: width / current.stageW,
  };
}

function finish(value) {
  modal.hidden = true;
  const done = current?.finish;
  current = null;
  done?.(value);
}

/** Keeps the item wholly on the page after it moves or changes size. */
function clamp() {
  const maxLeft = Math.max(0, current.stageW - item.offsetWidth);
  const maxTop = Math.max(0, current.stageH - item.offsetHeight);
  item.style.left = `${Math.max(0, Math.min(maxLeft, item.offsetLeft))}px`;
  item.style.top = `${Math.max(0, Math.min(maxTop, item.offsetTop))}px`;
}

function makeDraggable() {
  let drag = null;

  item.addEventListener('pointerdown', (e) => {
    if (!current) return;
    e.preventDefault();
    drag = {
      resize: e.target === grip && current.resize,
      startX: e.clientX,
      startY: e.clientY,
      left: item.offsetLeft,
      top: item.offsetTop,
      width: item.clientWidth,   // the content box, which is what resize() sets
    };
    try { item.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  });

  item.addEventListener('pointermove', (e) => {
    if (!drag || !current) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (drag.resize) {
      current.resize(Math.max(24, Math.min(current.stageW - item.offsetLeft, drag.width + dx)));
      clamp();
      return;
    }
    item.style.left = `${drag.left + dx}px`;
    item.style.top = `${drag.top + dy}px`;
    clamp();
  });

  const stop = () => { drag = null; };
  item.addEventListener('pointerup', stop);
  item.addEventListener('pointercancel', stop);
}
