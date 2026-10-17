// Select mode in the page editor: click any mark on the page to pick it up,
// drag it somewhere else, pull its corner to resize it, or delete it.
//
// While a drag is under way only the mark's own element moves. The stamp is
// written once, on release, so a drag is a single step for Undo.

import { $, el } from '../lib/dom.js';
import { stampById, updateStamp, removeStamp } from '../state.js';
import { noteMetrics } from '../assemble.js';
import { NOTE, wrapText } from '../lib/textwrap.js';

const layer = $('#viewerStamps');

let view = () => null;        // the viewer's current { page, wPt, hPt, scale }
let active = () => false;     // whether Select is the tool in hand
let picked = null;            // id of the selected stamp
const metrics = new Map();    // font -> note metrics, loaded when a note is picked

export function initArrange(getView, isSelecting) {
  view = getView;
  active = isSelecting;
  $('#viewPickedDelete').onclick = deletePicked;

  // A click on bare page lets go of whatever was picked.
  $('#viewerStage').addEventListener('pointerdown', (e) => {
    if (active() && picked && !e.target.closest('[data-id]')) pick(null);
  });
  wireDrag();
}

export const pickedId = () => picked;

/** Selects a mark (or nothing, with null) and redraws the handles. */
export function pick(id) {
  picked = id;
  const stamp = stampById(view()?.page, id);
  if (stamp?.type === 'note' && !metrics.has(stamp.font)) {
    noteMetrics(stamp.font).then((m) => metrics.set(stamp.font, m));
  }
  decorate();
}

export function deletePicked() {
  const page = view()?.page;
  if (!page || !picked) return false;
  removeStamp(page, picked);
  picked = null;
  decorate();
  return true;
}

const NAMES = {
  ink: 'Drawing',
  comment: 'Sticky note',
};

export function describeStamp(stamp) {
  if (stamp.role === 'signature') return 'Signature';
  if (stamp.type === 'note') return stamp.source === 'typed' ? 'Text' : 'Note';
  if (stamp.type === 'text') return `Watermark “${stamp.text}”`;
  if (stamp.type === 'image') return 'Image watermark';
  return NAMES[stamp.type] ?? 'Mark';
}

const resizable = (stamp) => (stamp.type === 'image' || stamp.type === 'note') && !stamp.rot;

/**
 * Marks the picked element and gives it a resize grip. Called after every
 * repaint of the stamp layer, since a repaint replaces the elements.
 */
export function decorate() {
  const page = view()?.page;
  const stamp = stampById(page, picked);
  if (!stamp) picked = null;

  for (const node of layer.children) {
    const on = node.dataset.id === picked;
    node.classList.toggle('picked', on);
    if (on && resizable(stamp) && !node.querySelector('.grip')) {
      node.append(el('span', { class: 'grip', title: 'Drag to resize' }));
    }
  }

  const bar = $('#viewPicked');
  bar.hidden = !picked;
  $('#viewPenHint').hidden = Boolean(picked);
  if (stamp) {
    $('#viewPickedName').textContent = `${describeStamp(stamp)} selected · drag to move${resizable(stamp) ? ', pull the corner to resize' : ''}`;
  }
}

/* ───────────────────────── dragging ───────────────────────── */

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** How far a stamp may travel before any of it would leave the page, in fractions. */
function travel(stamp) {
  if (stamp.type === 'ink') {
    const us = stamp.points.map((p) => p[0]);
    const vs = stamp.points.map((p) => p[1]);
    return { du: [-Math.min(...us), 1 - Math.max(...us)], dv: [-Math.min(...vs), 1 - Math.max(...vs)] };
  }
  return { du: [-stamp.u, 1 - stamp.u], dv: [-stamp.v, 1 - stamp.v] };
}

function wireDrag() {
  let drag = null;

  layer.addEventListener('pointerdown', (e) => {
    if (!active() || e.button > 0) return;
    const node = e.target.closest('[data-id]');
    const current = view();
    if (!node || !current) return;
    const stamp = stampById(current.page, node.dataset.id);
    if (!stamp) return;
    e.preventDefault();
    e.stopPropagation();
    if (picked !== stamp.id) pick(stamp.id);

    const box = layer.getBoundingClientRect();
    drag = {
      stamp,
      node,
      page: current.page,
      scale: current.scale,
      x0: e.clientX,
      y0: e.clientY,
      W: box.width,
      H: box.height,
      resize: e.target.classList.contains('grip') && resizable(stamp),
      base: node.style.transform,
      left: node.offsetLeft - node.offsetWidth / 2,   // the element is centered on its left/top
      top: node.offsetTop - node.offsetHeight / 2,
      width: node.offsetWidth,
      moved: false,
      patch: null,
    };
    try { node.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  });

  layer.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;   // a click, not a drag
    drag.moved = true;
    drag.patch = drag.resize ? resizeTo(drag, dx) : moveBy(drag, dx, dy);
  });

  const end = () => {
    if (!drag) return;
    const { moved, patch, page, stamp, resize } = drag;
    drag = null;
    if (moved && patch) updateStamp(page, stamp.id, patch, resize ? 'Resize a mark' : 'Move a mark');
  };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', end);
}

function moveBy(drag, dx, dy) {
  const { stamp, node, W, H } = drag;
  const room = travel(stamp);
  const du = clamp(dx / W, ...room.du);
  const dv = clamp(-dy / H, ...room.dv);
  node.style.transform = `translate(${du * W}px, ${-dv * H}px) ${drag.base}`;
  if (stamp.type === 'ink') {
    return {
      points: stamp.points.map(([u, v]) => [u + du, v + dv]),
      u: stamp.u + du,
      v: stamp.v + dv,
    };
  }
  return { u: stamp.u + du, v: stamp.v + dv };
}

/** Resizes from the bottom-right corner, keeping the top-left corner where it is. */
function resizeTo(drag, dx) {
  const { stamp, node, W, H, left, top, scale } = drag;
  let width = clamp(drag.width + dx, 16, W - left);
  let lines;

  if (stamp.type === 'note') {
    const m = metrics.get(stamp.font);
    if (!m) return null;   // still loading; the next move will catch up
    const pad = stamp.size * NOTE.pad;
    const widthPt = Math.max(stamp.size * 3 + 2 * pad, width / scale);
    width = widthPt * scale;
    lines = wrapText(stamp.text, widthPt - 2 * pad, (t) => m.measure(t, stamp.size));
    // Only the text changes; the grip being dragged must stay in place.
    const text = [...node.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
    if (text) text.nodeValue = lines.join('\n');
  }

  node.style.width = `${(width / W) * 100}%`;
  const height = node.offsetHeight;
  node.style.left = `${((left + width / 2) / W) * 100}%`;
  node.style.top = `${((top + height / 2) / H) * 100}%`;

  const patch = { w: width / W, u: (left + width / 2) / W, v: 1 - (top + height / 2) / H };
  if (lines) patch.lines = lines;
  return patch;
}
