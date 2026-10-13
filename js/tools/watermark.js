// Watermarks. A watermark is just a group of stamps queued onto pages; they are
// drawn at export time, which keeps them removable right up until you save.

import { $, $$, el, segment, bindRange, uid, parseRanges } from '../lib/dom.js';
import { state, on, addAsset, addStamps, removeStampGroup, stampGroups } from '../state.js';
import { toast } from '../ui/feedback.js';
import { normalizeAngle } from '../lib/geometry.js';
import { NOTE_TYPES } from './notes.js';

const TILE_COLS = 3;
const TILE_ROWS = 4;
const MARGIN = 0.07;           // keeps edge placements off the paper's edge

const ANCHORS = {
  tl: [MARGIN, 1 - MARGIN], tc: [0.5, 1 - MARGIN], tr: [1 - MARGIN, 1 - MARGIN],
  ml: [MARGIN, 0.5],        c:  [0.5, 0.5],        mr: [1 - MARGIN, 0.5],
  bl: [MARGIN, MARGIN],     bc: [0.5, MARGIN],     br: [1 - MARGIN, MARGIN],
};

const TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';

let kind = 'text';
let scope = 'all';
let position = 'c';
let asset = null;

export function initWatermark() {
  segment($('#wmKind'), (v) => {
    kind = v;
    $('#wmText').hidden = v !== 'text';
    $('#wmImage').hidden = v !== 'image';
  });
  segment($('#wmPos'), (v) => { position = v; });
  segment($('#wmScope'), (v) => {
    scope = v;
    $('#wmRange').hidden = v !== 'range';
  });

  bindRange($('#wmSize'), $('#wmSizeOut'), (v) => `${v} pt`);
  bindRange($('#wmOp'), $('#wmOpOut'), (v) => `${v}%`);
  bindAngle($('#wmRot'), $('#wmRotNum'));
  bindRange($('#wmW'), $('#wmWOut'), (v) => `${v}%`);

  $('#wmFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      asset = await addAsset(file);
      const preview = $('#wmPreview');
      preview.hidden = false;
      $('img', preview).src = asset.url;
    } catch (err) {
      toast(`Could not read that image: ${err.message}`, 'err');
    }
  });

  // Tiling fills the page, so a single placement no longer means anything.
  $('#wmTile').addEventListener('change', (e) => {
    $('#wmPos').style.opacity = e.target.checked ? '.4' : '1';
    $$('button', $('#wmPos')).forEach((b) => { b.disabled = e.target.checked; });
  });

  $('#btnWmApply').onclick = apply;

  on('pages', renderStampList);
  renderStampList();
}

const readAngle = (input) => normalizeAngle(Number(input.value) || 0);

// The slider is for quick dragging across ±90°; the box takes any exact value,
// decimals and upside-down angles included. The box is what gets applied.
function bindAngle(slider, box) {
  slider.addEventListener('input', () => { box.value = slider.value; });
  box.addEventListener('input', () => {
    if (box.value === '') return;
    slider.value = Math.max(-90, Math.min(90, readAngle(box)));
  });
  box.addEventListener('change', () => {
    box.value = readAngle(box);
    slider.value = Math.max(-90, Math.min(90, Number(box.value)));
  });
}

function targetsForScope() {
  if (scope === 'sel') {
    const chosen = state.pages.filter((p) => state.sel.has(p.uid));
    if (!chosen.length) throw new Error('No pages are selected.');
    return chosen;
  }
  if (scope === 'range') {
    const indices = parseRanges($('#wmRange').value, state.pages.length);
    return indices.map((i) => state.pages[i]);
  }
  return state.pages;
}

function apply() {
  let pages;
  try {
    pages = targetsForScope();
  } catch (err) {
    toast(err.message, 'err');
    return;
  }

  const base = {
    group: uid('wm'),
    rot: readAngle($('#wmRotNum')),
    opacity: Number($('#wmOp').value) / 100,
  };

  if (kind === 'text') {
    const text = $('#wmValue').value.trim();
    if (!text) { toast('Type the watermark text first.', 'err'); return; }
    Object.assign(base, {
      type: 'text',
      text,
      font: $('#wmFont').value,
      size: Number($('#wmSize').value),
      color: $('#wmColor').value,
    });
  } else {
    if (!asset) { toast('Choose a watermark image first.', 'err'); return; }
    Object.assign(base, { type: 'image', assetId: asset.id, w: Number($('#wmW').value) / 100 });
  }

  addStamps(pages, placements().map(([u, v]) => ({ ...base, u, v })));
  toast(`Watermark added to ${pages.length} page${pages.length === 1 ? '' : 's'}.`, 'ok');
}

function placements() {
  if (!$('#wmTile').checked) return [ANCHORS[position]];
  const spots = [];
  for (let row = 0; row < TILE_ROWS; row++) {
    for (let col = 0; col < TILE_COLS; col++) {
      spots.push([(col + 0.5) / TILE_COLS, (row + 0.5) / TILE_ROWS]);
    }
  }
  return spots;
}

function describe(stamp) {
  return stamp.type === 'text' ? `“${stamp.text}”` : 'Image watermark';
}

function renderStampList() {
  const host = $('#stampList');
  host.textContent = '';
  // Notes have their own list in the Notes panel.
  const groups = stampGroups().filter((g) => !NOTE_TYPES.has(g.stamp.type));
  if (!groups.length) return;

  host.append(el('hr'), el('div', { class: 'lbl', text: `Queued marks (${groups.length})` }));
  for (const g of groups) {
    host.append(el('div', { class: 'row' },
      el('span', { class: 'swatch', style: `background:${g.stamp.type === 'text' ? g.stamp.color : 'var(--accent)'}` }),
      el('div', { class: 'grow' },
        el('div', { text: describe(g.stamp) }),
        el('div', { class: 'sub', text: `${g.count} page${g.count === 1 ? '' : 's'} · ${Math.round(g.stamp.opacity * 100)}% opacity` })),
      el('button', { title: 'Remove', html: TRASH, onclick: () => removeStampGroup(g.group) })));
  }
  host.append(el('p', { class: 'hint', text: 'Marks are burned into the file when you export.' }));
}
