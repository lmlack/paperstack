// Drawing and typing straight onto a page in the full-size viewer.
//
//   Draw  each stroke becomes an "ink" stamp: a list of points in page
//         fractions, exported as a vector path.
//   Text  click where the text should start and type; Enter places it as a
//         bare note, Shift+Enter starts a new line, Esc throws it away.
//
// Both are ordinary stamps, so they show on the thumbnails, list under Notes,
// and come off again with the viewer's Undo.

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
  draw: 'Drag on the page to draw. Turn Draw off to scroll with a finger.',
  type: 'Click where the text should start. Enter places it, Shift+Enter adds a line, Esc cancels.',
};

const viewer = $('#viewer');
const layer = $('#viewerInk');
const sizeInput = $('#viewSize');

let mode = null;          // null | 'draw' | 'type'
let color = '#1d1d1f';
const size = { draw: SIZES.draw.value, type: SIZES.type.value };
let view = () => null;    // the viewer's current { page, wPt, hPt, scale }
let editor = null;        // the open text box, if any

export function initMarkup(getView) {
  view = getView;
  $('#viewDraw').onclick = () => setMode(mode === 'draw' ? null : 'draw');
  $('#viewType').onclick = () => setMode(mode === 'type' ? null : 'type');

  $('#viewSwatches').addEventListener('click', (e) => {
    const swatch = e.target.closest('button[data-c]');
    if (swatch) pickColor(swatch.dataset.c);
  });
  $('#viewColor').addEventListener('input', (e) => pickColor(e.target.value));
  sizeInput.addEventListener('input', () => {
    size[mode] = Number(sizeInput.value);
    showSize();
    if (editor) editor.restyle();
  });

  wirePen();
  layer.addEventListener('pointerdown', (e) => {
    if (mode !== 'type' || e.target !== layer) return;
    e.preventDefault();   // keep the focus for the box about to open
    finishText();
    openText(e);
  });
}

export const markupMode = () => mode;

export function setMode(next) {
  finishText();
  mode = next;
  viewer.classList.toggle('mode-draw', mode === 'draw');
  viewer.classList.toggle('mode-type', mode === 'type');
  $('#viewDraw').setAttribute('aria-pressed', String(mode === 'draw'));
  $('#viewType').setAttribute('aria-pressed', String(mode === 'type'));
  $('#viewPen').hidden = !mode;
  if (!mode) return;
  const spec = SIZES[mode];
  Object.assign(sizeInput, { min: spec.min, max: spec.max, step: spec.step });
  sizeInput.value = size[mode];
  $('#viewSizeLabel').textContent = spec.label;
  $('#viewPenHint').textContent = HINTS[mode];
  showSize();
}

function showSize() {
  $('#viewSizeOut').textContent = `${size[mode]} pt`;
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

function wirePen() {
  let stroke = null;   // { points: [[x, y]], path, svg, w, h }

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
      }]);
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

async function openText(e) {
  const current = view();
  if (!current) return;
  const { page, wPt, hPt, scale } = current;
  const metrics = await noteMetrics(FONT);
  const p = at(e);

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
      }]);
      if (text !== typed) toast('Some characters (like emoji) cannot be written into a PDF this way and became “?”.', 'err', 6500);
    },
  };

  box.addEventListener('input', fit);
  box.addEventListener('keydown', (ev) => {
    ev.stopPropagation();   // the viewer's own keys stay out of the way while typing
    if (ev.key === 'Escape') { ev.preventDefault(); finishText(false); }
    else if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finishText(); }
  });
  box.addEventListener('blur', () => { if (editor?.box === box) finishText(); });
  // Typing on the box should not start another one.
  box.addEventListener('pointerdown', (ev) => ev.stopPropagation());

  layer.append(box);
  editor.restyle();
  box.focus();
}

/** Places (or with keep=false, drops) the text being typed, if there is any. */
export function finishText(keep = true) {
  if (!editor) return;
  const open = editor;
  editor = null;
  open.box.remove();
  if (keep) open.commit();
}
