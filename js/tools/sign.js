// Signatures: draw with a pointer, type one in a script face, or upload a photo
// of a real one, in a dialog. Each one made is kept for the session, so it can
// go on any number of pages: pick it in the Sign panel or from the Sign button
// in the page editor. It lands on the page selected and ready to drag.

import { $, el, bindRange, segment, uid } from '../lib/dom.js';
import { state, on, addAsset, addCanvasAsset, addStamps, removeStampGroup, numberOf } from '../state.js';
import { displayInfo } from '../assemble.js';
import { toast } from '../ui/feedback.js';
import { openViewer, currentPage, visibleCenter } from '../ui/viewer.js';

let mode = 'draw';
let uploaded = null;        // asset from the Upload tab
let pad;                    // signature pad controller
let signatures = [];        // assets made this session, newest last

const TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';

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
    if (v === 'type') $('#sigTypeText').focus();
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
  typed.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#signConfirm').click(); });
  refreshTypePreview();

  $('#sigFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      uploaded = await addAsset(await keyOutWhite(file));
      const preview = $('#sigUploadPreview');
      preview.hidden = false;
      $('img', preview).src = uploaded.url;
    } catch (err) {
      toast(`Could not read that image: ${err.message}`, 'err');
    }
  });

  initDialog();

  // The dock: make one, or put an existing one on the chosen page.
  $('#btnSigNew').onclick = async () => {
    const page = chosenPage();
    if (!page) return;
    const asset = await createSignature();
    if (asset) await placeSignature(asset, page);
  };

  // The editor's Sign button: straight to the dialog the first time, then a
  // short menu of the signatures already made.
  $('#viewSign').onclick = async () => {
    live();
    if (!signatures.length) {
      const asset = await createSignature();
      const page = currentPage();
      if (asset && page) await placeSignature(asset, page, visibleCenter());
      return;
    }
    toggleMenu();
  };
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.viewer-signwrap')) toggleMenu(false);
  });

  on('pages', () => { refreshPageMenu(); renderPlaced(); });
  on('sources', () => { live(); renderSignatures(); });
  // Picking a single page in the grid makes it the signature's page.
  on('sel', () => {
    if (state.sel.size === 1) $('#sigPage').value = [...state.sel][0];
  });
  refreshPageMenu();
  renderSignatures();
}

function chosenPage() {
  const page = state.pages.find((p) => p.uid === $('#sigPage').value);
  if (!page) toast('Add a page first.', 'err');
  return page;
}

/** Start over releases every asset; forget the signatures that went with them. */
function live() {
  signatures = signatures.filter((a) => state.assets.has(a.id));
  if (uploaded && !state.assets.has(uploaded.id)) uploaded = null;
}

function refreshPageMenu() {
  const menu = $('#sigPage');
  const previous = menu.value;
  menu.textContent = '';
  state.pages.forEach((page, i) => menu.append(el('option', { value: page.uid, text: `Page ${i + 1}` })));
  if ([...menu.options].some((o) => o.value === previous)) menu.value = previous;
}

function renderSignatures() {
  const host = $('#sigList');
  host.textContent = '';
  for (const asset of signatures) {
    host.append(el('button', {
      class: 'sigcard',
      title: 'Put this signature on the page',
      'aria-label': 'Put this signature on the chosen page',
      onclick: () => { const page = chosenPage(); if (page) placeSignature(asset, page); },
    }, el('img', { src: asset.url, alt: '' })));
  }
  $('#sigListHint').hidden = !signatures.length;
  $('#btnSigNew').classList.toggle('primary', !signatures.length);
  $('#btnSigNew').lastChild.textContent = signatures.length ? 'Create another signature' : 'Create a signature';
}

/** The signatures already on pages, each with a way to find it and to remove it. */
function renderPlaced() {
  const host = $('#sigPlaced');
  host.textContent = '';
  const rows = [];
  state.pages.forEach((page, i) => {
    for (const stamp of page.stamps) {
      if (stamp.role !== 'signature') continue;
      const asset = state.assets.get(stamp.assetId);
      rows.push(el('div', { class: 'row' },
        el('button', {
          class: 'row-open',
          title: 'Show it on the page',
          onclick: () => openViewer(page.uid, { pick: stamp.id }),
        },
        asset ? el('img', { class: 'row-thumb', src: asset.url, alt: '' }) : null,
        el('div', { class: 'grow' },
          el('div', { text: 'Signature' }),
          el('div', { class: 'sub', text: `Page ${i + 1} · click to move it` }))),
        el('button', { title: 'Remove', 'aria-label': `Remove the signature on page ${i + 1}`, html: TRASH,
          onclick: () => removeStampGroup(stamp.group) })));
    }
  });
  if (!rows.length) return;
  host.append(el('hr'), el('div', { class: 'lbl', text: `On the pages (${rows.length})` }), ...rows);
}

/* ───────────────────────── the editor's menu ───────────────────────── */

function toggleMenu(force) {
  const menu = $('#viewSignMenu');
  const open = force ?? menu.hidden;
  $('#viewSign').setAttribute('aria-expanded', String(open));
  menu.hidden = !open;
  if (!open) return;
  menu.textContent = '';
  for (const asset of signatures) {
    menu.append(el('button', {
      role: 'menuitem',
      class: 'sigcard',
      'aria-label': 'Place this signature',
      onclick: () => {
        toggleMenu(false);
        const page = currentPage();
        if (page) placeSignature(asset, page, visibleCenter());
      },
    }, el('img', { src: asset.url, alt: '' })));
  }
  menu.append(el('button', {
    role: 'menuitem',
    class: 'btn tiny ghost',
    text: 'New signature…',
    onclick: async () => {
      toggleMenu(false);
      const asset = await createSignature();
      const page = currentPage();
      if (asset && page) await placeSignature(asset, page, visibleCenter());
    },
  }));
  menu.querySelector('button')?.focus();
}

/* ───────────────────────── the dialog ───────────────────────── */

let settle = null;     // resolves the open dialog
let opener = null;     // where the focus goes back to

function initDialog() {
  const close = () => finishDialog(null);
  $('#signClose').onclick = close;
  $('#signCancel').onclick = close;
  $('#signDialog').addEventListener('pointerdown', (e) => { if (e.target === $('#signDialog')) close(); });
  $('#signDialog').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  $('#signConfirm').onclick = async () => {
    let asset;
    try {
      asset = await currentAsset();
    } catch (err) {
      toast(err.message, 'err');
      return;
    }
    if (!signatures.includes(asset)) signatures.push(asset);
    renderSignatures();
    pad.clear();
    finishDialog(asset);
  };
}

/** Opens the dialog; resolves with the new signature's asset, or null. */
export function createSignature() {
  live();
  finishDialog(null);
  opener = document.activeElement;
  $('#signDialog').hidden = false;
  $('.sign-card').focus();
  return new Promise((resolve) => { settle = resolve; });
}

function finishDialog(value) {
  $('#signDialog').hidden = true;
  const done = settle;
  settle = null;
  if (done) {
    opener?.focus?.();
    done(value);
  }
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

/* ───────────────────────── placement ───────────────────────── */

/**
 * Puts a signature on a page and opens the page with it selected, so it can
 * be dragged into place straight away. `at` is where its center goes, as page
 * fractions (v up); by default the lower right, where signatures usually sit.
 */
export async function placeSignature(asset, page, at = null) {
  const { w: wPt, h: hPt } = await displayInfo(page);
  const ratio = asset.h / asset.w;
  // A third of the page wide, unless that would make a tall image very tall.
  let w = 0.3;
  if ((w * wPt * ratio) / hPt > 0.18) w = (0.18 * hPt) / (wPt * ratio);
  const h = (w * wPt * ratio) / hPt;
  const spot = at ?? { u: 0.92 - w / 2, v: 0.1 + h / 2 };
  const u = Math.max(w / 2, Math.min(1 - w / 2, spot.u));
  const v = Math.max(h / 2, Math.min(1 - h / 2, spot.v));

  const [stamp] = addStamps([page], [{
    group: uid('sig'),
    type: 'image',
    role: 'signature',
    assetId: asset.id,
    u,
    v,
    w,
    rot: 0,
    opacity: 1,
  }], 'Add a signature');
  openViewer(page.uid, { pick: stamp.id });
  toast(`Signature added to page ${numberOf(page)}. Drag it into place, or pull its corner to resize.`, 'ok', 5000, null, 'placed');
}
