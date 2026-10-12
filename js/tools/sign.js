// Signatures: draw with a pointer, type one in a script face, or upload a photo
// of a real one. The result is trimmed to its ink, then dragged into place on a
// full-size render of the chosen page.

import { $, el, bindRange, segment } from '../lib/dom.js';
import { state, on, addAsset, addCanvasAsset, addStamps } from '../state.js';
import { renderPage } from '../pdfjs.js';
import { displayInfo } from '../assemble.js';
import { withBusy, toast } from '../ui/feedback.js';

const STAGE_MAX = { w: 780, h: 460 };

let mode = 'draw';
let uploaded = null;        // asset from the Upload tab
let pad;                    // signature pad controller

export function initSign() {
  pad = createPad($('#sigPad'));
  bindRange($('#sigPen'), $('#sigPenOut'), (v) => `${v} px`);
  $('#sigPen').addEventListener('input', (e) => pad.setWidth(Number(e.target.value)));
  $('#sigInk').addEventListener('input', (e) => pad.setColor(e.target.value));
  $('#btnSigUndo').onclick = () => pad.undo();
  $('#btnSigClear').onclick = () => pad.clear();

  segment($('#sgMode'), (v) => {
    mode = v;
    $('#sgDraw').hidden = v !== 'draw';
    $('#sgType').hidden = v !== 'type';
    $('#sgUpload').hidden = v !== 'upload';
  });

  const typed = $('#sigTypeText');
  const face = $('#sigTypeFont');
  const refreshTypePreview = () => {
    const preview = $('#sigTypePreview');
    preview.style.fontFamily = face.value;
    preview.textContent = typed.value || 'Your signature';
    preview.style.opacity = typed.value ? '1' : '.4';
  };
  typed.addEventListener('input', refreshTypePreview);
  face.addEventListener('change', refreshTypePreview);
  refreshTypePreview();

  $('#sigFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      uploaded = await addAsset(await keyOutWhite(file));
      toast('Signature image ready. Pick a page and position it.', 'ok');
    } catch (err) {
      toast(`Could not read that image: ${err.message}`, 'err');
    }
  });

  $('#btnSigPlace').onclick = openPlacement;
  on('pages', refreshPageMenu);
  refreshPageMenu();
  initPlacementStage();
}

function refreshPageMenu() {
  const menu = $('#sigPage');
  const previous = menu.value;
  menu.textContent = '';
  state.pages.forEach((page, i) => menu.append(el('option', { value: page.uid, text: `Page ${i + 1}` })));
  if ([...menu.options].some((o) => o.value === previous)) menu.value = previous;
}

/* ───────────────────────── the pad ───────────────────────── */

function createPad(canvas) {
  const ctx = canvas.getContext('2d');
  const wrap = canvas.parentElement;
  let strokes = [];
  let current = null;
  let width = 3;
  let color = '#10213f';

  // The canvas is a fixed 760×300 bitmap stretched by CSS, so pointer positions
  // need scaling from layout pixels into bitmap pixels.
  const at = (e) => {
    const box = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - box.left) / box.width) * canvas.width,
      y: ((e.clientY - box.top) / box.height) * canvas.height,
    };
  };

  function repaint() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const stroke of strokes) {
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.beginPath();
      stroke.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (stroke.points.length === 1) {
        // A single tap should still leave a dot.
        ctx.arc(stroke.points[0].x, stroke.points[0].y, stroke.width / 2, 0, Math.PI * 2);
        ctx.fillStyle = stroke.color;
        ctx.fill();
      }
      ctx.stroke();
    }
    wrap.classList.toggle('inked', strokes.length > 0);
  }

  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    current = { color, width: width * 2, points: [at(e)] };
    strokes.push(current);
    repaint();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    current.points.push(at(e));
    repaint();
  });
  const stop = () => { current = null; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);

  return {
    get empty() { return strokes.length === 0; },
    setWidth(v) { width = v; },
    setColor(v) { color = v; },
    undo() { strokes.pop(); repaint(); },
    clear() { strokes = []; repaint(); },
    canvas,
  };
}

/* ───────────────────────── building the asset ───────────────────────── */

async function currentAsset() {
  if (mode === 'upload') {
    // Clearing the workspace releases every asset, so re-check it is still live.
    if (uploaded && !state.assets.has(uploaded.id)) uploaded = null;
    if (!uploaded) throw new Error('Choose an image of your signature first.');
    return uploaded;
  }
  if (mode === 'type') {
    const text = $('#sigTypeText').value.trim();
    if (!text) throw new Error('Type your name first.');
    return addCanvasAsset(trim(renderTypedSignature(text, $('#sigTypeFont').value, $('#sigInk').value)));
  }
  if (pad.empty) throw new Error('Draw your signature in the box first.');
  return addCanvasAsset(trim(pad.canvas));
}

function renderTypedSignature(text, fontFamily, color) {
  const size = 150;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${size}px ${fontFamily}`;
  const metrics = ctx.measureText(text);
  canvas.width = Math.ceil(metrics.width + size * 0.6);
  canvas.height = Math.ceil(size * 1.8);

  const paint = canvas.getContext('2d');
  paint.font = `${size}px ${fontFamily}`;
  paint.fillStyle = color;
  paint.textBaseline = 'middle';
  paint.fillText(text, size * 0.3, canvas.height / 2);
  return canvas;
}

/** Crops transparent margins so the signature sits tight in its box. */
function trim(canvas, padding = 6) {
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let top = canvas.height, left = canvas.width, right = -1, bottom = -1;

  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (data[(y * canvas.width + x) * 4 + 3] < 12) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return canvas;   // nothing drawn

  left = Math.max(0, left - padding);
  top = Math.max(0, top - padding);
  right = Math.min(canvas.width - 1, right + padding);
  bottom = Math.min(canvas.height - 1, bottom + padding);

  const out = document.createElement('canvas');
  out.width = right - left + 1;
  out.height = bottom - top + 1;
  out.getContext('2d').drawImage(canvas, -left, -top);
  return out;
}

/**
 * Scanned or photographed signatures arrive on white paper. Anything near-white
 * becomes transparent, and the remaining ink keeps a soft alpha edge so it does
 * not look cut out with scissors.
 */
async function keyOutWhite(file, threshold = 232) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const luma = d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722;
    if (luma >= threshold) { d[i + 3] = 0; continue; }
    d[i + 3] = Math.min(255, Math.round(d[i + 3] * (1 - luma / threshold) * 1.6));
  }
  ctx.putImageData(img, 0, 0);

  const trimmed = trim(canvas);
  const blob = await new Promise((r) => trimmed.toBlob(r, 'image/png'));
  return new File([blob], 'signature.png', { type: 'image/png' });
}

/* ───────────────────────── placement stage ───────────────────────── */

const modal = $('#placeModal');
const stage = $('#placeStage');
const item = $('#placeItem');
let placing = null;   // { page, asset, stageW, stageH }

function initPlacementStage() {
  $('#placeClose').onclick = closePlacement;
  $('#placeCancel').onclick = closePlacement;
  $('#placeConfirm').onclick = confirmPlacement;
  modal.addEventListener('pointerdown', (e) => { if (e.target === modal) closePlacement(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closePlacement();
  });
  makeDraggable();
}

async function openPlacement() {
  const page = state.pages.find((p) => p.uid === $('#sigPage').value);
  if (!page) { toast('Add a page first.', 'err'); return; }

  let asset;
  try {
    asset = await currentAsset();
  } catch (err) {
    toast(err.message, 'err');
    return;
  }

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

    // Default: a third of the page width, sitting on the lower right.
    const width = canvas.width * 0.33;
    const height = width * (asset.h / asset.w);
    Object.assign(item.style, {
      width: `${width}px`,
      height: `${height}px`,
      left: `${canvas.width * 0.58}px`,
      top: `${canvas.height * 0.76}px`,
    });
    $('img', item).src = asset.url;

    placing = { page, asset, stageW: canvas.width, stageH: canvas.height, ratio: asset.h / asset.w };
    modal.hidden = false;
  });
}

function closePlacement() {
  modal.hidden = true;
  placing = null;
}

function makeDraggable() {
  let drag = null;

  item.addEventListener('pointerdown', (e) => {
    if (!placing) return;
    e.preventDefault();
    const box = item.getBoundingClientRect();
    drag = {
      resize: e.target.classList.contains('grip'),
      startX: e.clientX,
      startY: e.clientY,
      left: item.offsetLeft,
      top: item.offsetTop,
      width: box.width,
    };
    try { item.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  });

  item.addEventListener('pointermove', (e) => {
    if (!drag || !placing) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (drag.resize) {
      const width = Math.max(24, Math.min(placing.stageW, drag.width + dx));
      item.style.width = `${width}px`;
      item.style.height = `${width * placing.ratio}px`;
      return;
    }
    const maxLeft = placing.stageW - item.offsetWidth;
    const maxTop = placing.stageH - item.offsetHeight;
    item.style.left = `${Math.max(0, Math.min(maxLeft, drag.left + dx))}px`;
    item.style.top = `${Math.max(0, Math.min(maxTop, drag.top + dy))}px`;
  });

  const stop = () => { drag = null; };
  item.addEventListener('pointerup', stop);
  item.addEventListener('pointercancel', stop);
}

function confirmPlacement() {
  if (!placing) return;
  const { page, asset, stageW, stageH } = placing;
  const width = item.offsetWidth;
  const height = item.offsetHeight;

  addStamps([page], [{
    group: `sig-${asset.id}-${Date.now()}`,
    type: 'image',
    assetId: asset.id,
    u: (item.offsetLeft + width / 2) / stageW,
    v: 1 - (item.offsetTop + height / 2) / stageH,   // stage is y-down, PDFs are y-up
    w: width / stageW,
    rot: 0,
    opacity: 1,
  }]);

  const index = state.pages.indexOf(page) + 1;
  closePlacement();
  toast(`Signature placed on page ${index}.`, 'ok');
}
