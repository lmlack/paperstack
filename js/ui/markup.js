// The page editor's tools, and drawing and typing straight onto a page.
//
//   Select       the default: pick up any mark and move or resize it (arrange.js).
//   Draw         each stroke becomes an "ink" stamp: a list of points in page
//                fractions, exported as a vector path.
//   Text         click where the text should start and type; Enter places it as
//                a bare note, Shift+Enter starts a new line, Esc throws it away.
//   Sticky note  click the spot the comment is about and type it; it becomes a
//                real PDF comment that opens in other apps and does not print.
//
// All of them are ordinary stamps, so they show on the thumbnails, list under
// Notes, and come off again with Undo.

import { $, $$, el, uid } from '../lib/dom.js';
import { addStamps } from '../state.js';
import { noteMetrics } from '../assemble.js';
import { NOTE, wrapText } from '../lib/textwrap.js';
import { toast } from './feedback.js';

const SVG = 'http://www.w3.org/2000/svg';
const FONT = 'Helvetica';
const SIZES = {
  draw: { label: 'Pen', min: 1, max: 12, step: 0.5, value: 2 },
  type: { label: 'Size', min: 8, max: 48, step: 1, value: 14 },
};
const HINTS = {
  select: 'Click a mark to select it, then drag it or pull its corner. Pick a tool to add something new.',
  draw: 'Drag on the page to draw. Switch to Select to scroll with a finger.',
  type: 'Click where the text should start. Enter places it, Shift+Enter adds a line, Esc cancels.',
  note: 'Click the spot the note is about, then type. It opens as a comment in other PDF apps and does not print.',
};
const STICKY = '#ffd60a';

const viewer = $('#viewer');
const layer = $('#viewerInk');
const sizeInput = $('#viewSize');

let mode = 'select';      // 'select' | 'draw' | 'type' | 'note'
let color = '#1d1d1f';
const size = { draw: SIZES.draw.value, type: SIZES.type.value };
let view = () => null;    // the viewer's current { page, wPt, hPt, scale }
let editor = null;        // the open text box, if any

export function initMarkup(getView) {
  view = getView;
  // Pressing the tool that is already on goes back to Select.
  for (const b of $$('.viewer-mode[data-mode]')) {
    b.onclick = () => setMode(mode === b.dataset.mode ? 'select' : b.dataset.mode);
  }

  $('#viewSwatches').addEventListener('click', (e) => {
    const swatch = e.target.closest('button[data-c]');
    if (swatch) pickColor(swatch.dataset.c);
  });
  $('#viewColor').addEventListener('input', (e) => pickColor(e.target.value));
  sizeInput.addEventListener('input', () => {
    if (!SIZES[mode]) return;
    size[mode] = Number(sizeInput.value);
    showSize();
    if (editor) editor.restyle();
  });

  wirePen();
  layer.addEventListener('pointerdown', (e) => {
    if ((mode !== 'type' && mode !== 'note') || e.target !== layer) return;
    e.preventDefault();   // keep the focus for the box about to open
    // Tapping away from a box with words in it places them, and that is all:
    // the tool goes back to Select. An empty box just moves to the new spot.
    if (editor?.box.value.trim()) { finishText(); return; }
    finishText(false);
    openText(e, mode);
  });
  $('#viewDone').onclick = () => setMode('select');
}

export const markupMode = () => mode;

let onModeChange = () => {};
export const whenModeChanges = (fn) => { onModeChange = fn; };

export function setMode(next) {
  finishText();
  mode = next ?? 'select';
  for (const m of ['select', 'draw', 'type', 'note']) viewer.classList.toggle(`mode-${m}`, mode === m);
  for (const b of $$('.viewer-mode[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  // A plain way back to Select, where a swipe turns the page again.
  $('#viewDone').hidden = mode === 'select';
  $('#viewPenHint').textContent = HINTS[mode];
  $('#viewPen').hidden = !SIZES[mode];
  onModeChange(mode);
  if (!SIZES[mode]) return;
  const spec = SIZES[mode];
  Object.assign(sizeInput, { min: spec.min, max: spec.max, step: spec.step });
  sizeInput.value = size[mode];
  $('#viewSizeLabel').textContent = spec.label;
  showSize();
}

function showSize() {
  if (SIZES[mode]) $('#viewSizeOut').textContent = `${size[mode]} pt`;
}

function pickColor(value) {
  color = value;
  $('#viewColor').value = value;
  $$('#viewSwatches button').forEach((b) => b.classList.toggle('active', b.dataset.c === value));
  if (editor) editor.restyle();
}

/** Where a pointer is on the page, in sheet pixels from the top-left. */
function at(e) {
  const box = layer.getBoundingClientRect();
  return { x: e.clientX - box.left, y: e.clientY - box.top, w: box.width, h: box.height };
}

/* ───────────────────────── draw ───────────────────────── */

/** Drops a line still being drawn, e.g. when a second finger turns it into a pinch. */
export let cancelStroke = () => {};

function wirePen() {
  let stroke = null;   // { points: [[x, y]], path, svg, w, h }
  cancelStroke = () => {
    stroke?.svg.remove();
    stroke = null;
  };

  layer.addEventListener('pointerdown', (e) => {
    if (mode !== 'draw' || !view()) return;
    e.preventDefault();
    try { layer.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    const p = at(e);
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${p.w} ${p.h}`);
    const path = document.createElementNS(SVG, 'path');
    path.style.stroke = color;
    path.style.strokeWidth = `${size.draw * view().scale}px`;
    svg.append(path);
    layer.append(svg);
    stroke = { points: [[p.x, p.y]], path, svg, w: p.w, h: p.h };
    redraw(stroke);
  });

  layer.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const p = at(e);
    const [lx, ly] = stroke.points.at(-1);
    // Skip sub-pixel jitter; it only bloats the PDF.
    if (Math.hypot(p.x - lx, p.y - ly) < 1.5) return;
    stroke.points.push([p.x, p.y]);
    redraw(stroke);
  });

  const end = () => {
    if (!stroke) return;
    const done = stroke;
    stroke = null;
    const current = view();
    if (current) {
      const points = done.points.map(([x, y]) => [round(clamp01(x / done.w)), round(clamp01(1 - y / done.h))]);
      const us = points.map((p) => p[0]);
      const vs = points.map((p) => p[1]);
      addStamps([current.page], [{
        group: uid('ink'),
        type: 'ink',
        points,
        width: size.draw,
        color,
        // The center of the line, so it sits with the other stamps in lists.
        u: (Math.min(...us) + Math.max(...us)) / 2,
        v: (Math.min(...vs) + Math.max(...vs)) / 2,
        rot: 0,
        opacity: 1,
      }], 'Draw a line');
    }
    done.svg.remove();   // the stamp layer draws it from here on
  };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', end);
}

function redraw({ points, path }) {
  const pts = points.length === 1 ? [points[0], points[0]] : points;
  path.setAttribute('d', pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(''));
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const round = (n) => Math.round(n * 1e5) / 1e5;

/* ───────────────────────── type ───────────────────────── */

async function openText(e, kind) {
  const current = view();
  if (!current) return;
  const p = at(e);
  if (kind === 'note') { openSticky(current, p); return; }
  const { page, wPt, hPt, scale } = current;
  const metrics = await noteMetrics(FONT);

  const box = el('textarea', { spellcheck: 'false', 'aria-label': 'Text to place on the page' });
  const state = { size: size.type, color };
  // The click marks the middle of the first line, which is where people aim.
  let leftPt = p.x / scale - state.size * NOTE.pad;
  let topPt = p.y / scale - state.size * (NOTE.pad + NOTE.line / 2);

  const fit = () => {
    const s = state.size;
    const pad = s * NOTE.pad;
    const lines = (box.value || ' ').split('\n');
    const widest = Math.max(...lines.map((l) => metrics.measure(metrics.clean(l), s)));
    const widthPt = Math.min(wPt, widest + 2 * pad + s * 0.6);
    const heightPt = lines.length * s * NOTE.line + 2 * pad;
    leftPt = Math.max(0, Math.min(leftPt, wPt - widthPt));
    topPt = Math.max(0, Math.min(topPt, hPt - heightPt));
    Object.assign(box.style, {
      left: `${leftPt * scale}px`,
      top: `${topPt * scale}px`,
      width: `${widthPt * scale}px`,
      height: `${heightPt * scale}px`,
    });
  };

  editor = {
    page,
    box,
    restyle() {
      state.size = size.type;
      state.color = color;
      Object.assign(box.style, {
        fontFamily: 'Helvetica, Arial, sans-serif',
        fontWeight: '400',
        fontSize: `${state.size * scale}px`,
        lineHeight: String(NOTE.line),
        padding: `${state.size * NOTE.pad * scale}px`,
        color: state.color,
      });
      fit();
    },
    commit() {
      const typed = box.value.replace(/\s+$/, '');
      if (!typed.trim()) return;
      const s = state.size;
      const pad = s * NOTE.pad;
      const text = metrics.clean(typed);
      const measure = (t) => metrics.measure(t, s);
      // Wrap at the page edge, then shrink the box to the text it holds.
      const room = Math.max(s * 3, wPt - leftPt - 2 * pad);
      const lines = wrapText(text, room, measure);
      const widthPt = Math.max(...lines.map(measure)) + 2 * pad + s * 0.1;
      const heightPt = lines.length * s * NOTE.line + 2 * pad;
      const left = Math.max(0, Math.min(leftPt, wPt - widthPt));
      const top = Math.max(0, Math.min(topPt, hPt - heightPt));
      addStamps([page], [{
        group: uid('note'),
        type: 'note',
        source: 'typed',
        text,
        lines,
        font: FONT,
        size: s,
        color: state.color,
        bg: null,
        u: (left + widthPt / 2) / wPt,
        v: 1 - (top + heightPt / 2) / hPt,
        w: widthPt / wPt,
        rot: 0,
        opacity: 1,
      }], 'Add text');
      if (text !== typed) toast('Some characters (like emoji) cannot be written into a PDF this way and became “?”.', 'err', 6500);
      return true;
    },
  };

  box.addEventListener('input', fit);
  wireEditorKeys(box);

  layer.append(box);
  editor.restyle();
  box.focus();
}

/**
 * A sticky note: the icon goes where the page was clicked, and a small card
 * opens beside it for the comment. The text is kept as typed; a PDF comment
 * holds any character, emoji included.
 */
function openSticky({ page }, p) {
  const u = clamp01(p.x / p.w);
  const v = clamp01(1 - p.y / p.h);
  const pin = el('div', { class: 'sticky-pin', style: `left:${p.x}px;top:${p.y}px;background:${STICKY}` });
  const box = el('textarea', {
    class: 'sticky-editor',
    spellcheck: 'true',
    placeholder: 'Write the note…',
    'aria-label': 'Sticky note text',
  });
  // Open toward whichever side has room.
  Object.assign(box.style, p.x > p.w * 0.6 ? { right: `${p.w - p.x + 16}px` } : { left: `${p.x + 16}px` });
  box.style.top = `${Math.min(p.y, p.h - 110)}px`;

  editor = {
    page,
    box,
    nodes: [pin, box],
    restyle() {},
    commit() {
      const text = box.value.replace(/\s+$/, '');
      if (!text.trim()) return;
      addStamps([page], [{
        group: uid('comment'),
        type: 'comment',
        text,
        color: STICKY,
        created: Date.now(),
        u,
        v,
        rot: 0,
        opacity: 1,
      }], 'Add a sticky note');
      return true;
    },
  };
  wireEditorKeys(box);
  layer.append(pin, box);
  box.focus();
}

function wireEditorKeys(box) {
  box.addEventListener('keydown', (ev) => {
    ev.stopPropagation();   // the viewer's own keys stay out of the way while typing
    if (ev.key === 'Escape') { ev.preventDefault(); finishText(false); }
    else if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finishText(); }
  });
  box.addEventListener('blur', () => { if (editor?.box === box) finishText(); });
  box.addEventListener('pointerdown', (ev) => ev.stopPropagation());
}

/** Places (or with keep=false, drops) the text being typed, if there is any. */
export function finishText(keep = true) {
  if (!editor) return;
  const open = editor;
  editor = null;
  for (const node of open.nodes ?? [open.box]) node.remove();
  // Text and sticky notes are one at a time: once one is placed, the tool is
  // put down, so the page can be swiped or the new mark dragged straight away.
  if (keep && open.commit()) setMode('select');
}
