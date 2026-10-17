// The page grid: thumbnails, selection, drag-to-reorder, per-page actions and
// live stamp previews. Thumbnails render lazily as tiles scroll into view.

import { $, el } from '../lib/dom.js';
import { thumbnail, rotateCanvas } from '../pdfjs.js';
import { paintStamps } from './stamps.js';
import { openViewer } from './viewer.js';
import { toast } from './feedback.js';
import { undoable } from './history.js';
import { openMenu, closeMenu } from './menu.js';
import { intake, pickFiles, insertBlank } from './intake.js';
import {
  state, on, srcOf, rotatePages, deletePages, duplicatePages, movePages,
  toggleSelection, selectRangeTo, liveSources, numberOf,
} from '../state.js';

const grid = $('#pagegrid');
const selCount = $('#selCount');

const ICON = {
  left:  '<svg viewBox="0 0 24 24"><path d="M9 4 4.5 8.5 9 13"/><path d="M4.5 8.5h8A6.5 6.5 0 0 1 19 15v1"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="m15 4 4.5 4.5L15 13"/><path d="M19.5 8.5h-8A6.5 6.5 0 0 0 5 15v1"/></svg>',
  copy:  '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a2 2 0 0 0-2 2v9"/></svg>',
  edit:  '<svg viewBox="0 0 24 24"><path d="m15.5 4.5 4 4L9 19H5v-4Z"/><path d="m13 7 4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
  plus:  '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  page:  '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
  file:  '<svg viewBox="0 0 24 24"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
};

/** The page tiles, in order. The grid also ends with the add tile. */
const tiles = () => [...grid.querySelectorAll(':scope > .tile')];

// Pages from different files get different dots, so a merged document shows
// where each page came from.
const SOURCE_COLORS = ['#1f8fff', '#e0518f', '#f0a020', '#2bb673', '#8b5cf6', '#e5603b'];
export function sourceColor(srcId) {
  const i = liveSources().findIndex((s) => s.id === srcId);
  return SOURCE_COLORS[(i < 0 ? 0 : i) % SOURCE_COLORS.length];
}

/** The two ways to put pages in at position `at`, as menu items. */
export const insertChoices = (at) => [
  { label: 'Blank page', hint: 'The same size as its neighbor', icon: ICON.page, run: () => insertBlank(at) },
  { label: 'PDF or image files…', hint: 'From your device', icon: ICON.file, run: () => pickFiles(at) },
];

// The last thing in the grid: a dashed tile for adding pages at the end.
const addTile = el('div', { class: 'add-tile' },
  el('button', { class: 'add-tile-btn', id: 'addBlank', title: 'Add a blank page at the end',
    onclick: () => insertBlank(state.pages.length) },
  el('span', { html: ICON.page }), el('b', { text: 'Blank page' })),
  el('button', { class: 'add-tile-btn', id: 'addMore', title: 'Add PDFs or images at the end',
    onclick: () => pickFiles(null) },
  el('span', { html: ICON.file }), el('b', { text: 'Add files' })));

let anchorUid = null;         // for shift-click ranges
let dragUids = [];            // pages currently being dragged
let thumbWidth = 320;

/* ───────────────────────── lazy thumbnails ───────────────────────── */

const seen = new WeakSet();

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    observer.unobserve(entry.target);
    paintThumb(entry.target);
  }
}, { root: grid, rootMargin: '400px 0px' });

async function paintThumb(tile) {
  if (seen.has(tile)) return;
  seen.add(tile);
  const page = state.pages.find((p) => p.uid === tile.dataset.uid);
  if (!page) return;
  const holder = $('.thumb', tile);
  try {
    const { canvas: base, wPt, hPt } = await thumbnail(srcOf(page), page.index, thumbWidth);
    const canvas = rotateCanvas(base, page.rot);
    // Width of the page as displayed, in points. A quarter turn swaps the axes.
    tile.dataset.pageWidthPt = page.rot % 180 === 0 ? wPt : hPt;
    holder.dataset.rot = page.rot;
    $('.skel', holder)?.remove();
    const old = $('canvas', holder);
    if (old) old.replaceWith(canvas); else holder.prepend(canvas);
    holder.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
    drawStamps(tile, page);
  } catch (err) {
    console.error(err);
    $('.skel', holder)?.remove();
    holder.append(el('span', { class: 'muted', text: 'preview failed' }));
  }
}

function drawStamps(tile, page) {
  paintStamps($('.stamps', tile), page, Number(tile.dataset.pageWidthPt));
  showMarks(tile, page);
}

/* ───────────────────────── rendering the grid ───────────────────────── */

function tileFor(page, number) {
  const src = srcOf(page);
  const tile = el('div', { class: 'tile', 'data-uid': page.uid, draggable: 'true' });

  const thumb = el('div', { class: 'thumb', tabindex: '0', role: 'button' });
  labelThumb(thumb, page, number);
  // The way into the page editor. A labeled pill over the page on hover, and
  // always showing in the corner on a touch screen, where there is no hover.
  thumb.append(
    el('div', { class: 'skel' }),
    el('div', { class: 'stamps' }),
    el('span', { class: 'marks', hidden: true }),
    el('button', {
      class: 'expand',
      title: `Edit page ${number}: sign, draw, type and move marks`,
      'aria-label': `Edit page ${number}`,
      onclick: (e) => { e.stopPropagation(); openViewer(page.uid); },
    }, el('span', { html: `${ICON.edit}<b>Edit</b>` })),
  );

  const acts = el('div', { class: 'acts' });
  acts.append(
    el('button', { title: 'Rotate left', html: ICON.left,
      onclick: (e) => { e.stopPropagation(); rotatePages([page], -90); } }),
    el('button', { title: 'Rotate right', html: ICON.right,
      onclick: (e) => { e.stopPropagation(); rotatePages([page], 90); } }),
    el('button', { title: 'Duplicate', html: ICON.copy,
      onclick: (e) => { e.stopPropagation(); duplicatePages([page]); } }),
    el('button', { class: 'rm', title: 'Delete page', html: ICON.trash,
      onclick: (e) => { e.stopPropagation(); deleteWithUndo([page]); } }),
  );

  const bar = el('div', { class: 'tile-bar' },
    el('span', { class: 'num', text: String(number) }),
    el('span', { class: 'src', title: src.name }),
    acts);
  showSource(bar, page);

  // Between this page and the one before: a "+" to put something in here.
  const slot = el('button', {
    class: 'slot',
    title: 'Insert pages here',
    'aria-label': `Insert pages before page ${number}`,
    html: ICON.plus,
    onclick: (e) => {
      e.stopPropagation();
      openMenu(slot, insertChoices(tiles().indexOf(tile)), { label: 'Insert here' });
    },
  });

  for (const b of acts.children) b.setAttribute('aria-label', `${b.title}, page ${number}`);
  tile.append(slot, thumb, bar);
  return tile;
}

/**
 * The file a page came from, once there are several: a colored dot, with the
 * name on hover. The name itself never fit beside the page buttons; the same
 * dots key the Open files list in Organize.
 */
function showSource(bar, page) {
  const src = srcOf(page);
  const host = $('.src', bar);
  host.textContent = '';
  if (liveSources().length < 2) { host.removeAttribute('title'); return; }
  host.title = `From ${src.name}`;
  host.append(el('i', { class: 'srcdot', style: `background:${sourceColor(page.srcId)}`, 'aria-label': `From ${src.name}` }));
}

function labelThumb(thumb, page, number) {
  const marks = page.stamps.length;
  thumb.setAttribute('aria-label', [
    `Page ${number}`,
    page.rot ? `rotated ${page.rot}°` : '',
    marks ? `${marks} mark${marks === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(', '));
}

/** Deletes pages from the grid, refusing to empty the document, with an Undo on the toast. */
export function deleteWithUndo(pages) {
  if (pages.length >= state.pages.length) {
    toast('That would delete every page. Keep at least one.', 'err');
    return;
  }
  const what = pages.length === 1 ? `page ${numberOf(pages[0])}` : `${pages.length} pages`;
  deletePages(pages);
  undoable(`Deleted ${what}.`);
}

/** A small count of the marks queued on a page, so edited pages stand out. */
function showMarks(tile, page) {
  const badge = $('.marks', tile);
  const n = page.stamps.length;
  badge.hidden = !n;
  badge.textContent = n ? `${n} mark${n === 1 ? '' : 's'}` : '';
}

export function renderGrid() {
  const existing = new Map(tiles().map((n) => [n.dataset.uid, n]));
  const next = [];

  state.pages.forEach((page, i) => {
    let tile = existing.get(page.uid);
    if (tile) {
      existing.delete(page.uid);
      $('.num', tile).textContent = String(i + 1);
      showSource($('.tile-bar', tile), page);
      $('.slot', tile).setAttribute('aria-label', `Insert pages before page ${i + 1}`);
      const thumb = $('.thumb', tile);
      labelThumb(thumb, page, i + 1);
      $('.expand', thumb).setAttribute('aria-label', `Edit page ${i + 1}`);
      const canvas = $('canvas', thumb);
      // Rotation changed under us: re-derive the canvas from the cached render.
      if (canvas && thumb.dataset.rot !== String(page.rot)) {
        seen.delete(tile);
        paintThumb(tile);
      } else if (canvas) {
        drawStamps(tile, page);
      }
    } else {
      tile = tileFor(page, i + 1);
      observer.observe(tile);
    }
    next.push(tile);
  });

  for (const stale of existing.values()) { observer.unobserve(stale); stale.remove(); }
  // Re-append in order; the DOM keeps live nodes, so thumbnails survive a reorder.
  grid.append(...next, addTile);
  renderSelection();
}

export function renderSelection() {
  for (const tile of tiles()) tile.classList.toggle('sel', state.sel.has(tile.dataset.uid));
  const n = state.sel.size;
  selCount.textContent = n ? `${n} of ${state.pages.length} selected` : '';
  $('#selActions').hidden = !n;
  $('#gridHint').hidden = Boolean(n);
  $('#btnSelectNone').hidden = !n;
}

export function setThumbScale(px) {
  grid.style.setProperty('--tile', `${px}px`);
  const want = px <= 160 ? 240 : px <= 240 ? 320 : 460;
  if (want !== thumbWidth) {
    thumbWidth = want;
    for (const tile of tiles()) { seen.delete(tile); paintThumb(tile); }
  }
}

/* ───────────────────────── interaction ───────────────────────── */

grid.addEventListener('dblclick', (e) => {
  const tile = e.target.closest('.tile');
  if (tile && !e.target.closest('.acts, .slot')) openViewer(tile.dataset.uid);
});

grid.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || e.target.closest('.acts, .slot')) return;
  const u = tile.dataset.uid;
  if (e.shiftKey && anchorUid) selectRangeTo(u, anchorUid);
  else { toggleSelection(u, e.metaKey || e.ctrlKey); anchorUid = u; }
});

// Keyboard: arrows move between pages, Space selects, Enter opens the editor.
grid.addEventListener('keydown', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || e.target !== $('.thumb', tile)) return;
  const tiles = tiles();
  const at = tiles.indexOf(tile);
  const perRow = Math.max(1, Math.round(grid.clientWidth / (tile.offsetWidth || 1)));
  const jump = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow }[e.key];

  if (jump) {
    e.preventDefault();
    const next = tiles[Math.max(0, Math.min(tiles.length - 1, at + jump))];
    $('.thumb', next).focus();
    if (e.shiftKey) selectRangeTo(next.dataset.uid, anchorUid ?? tile.dataset.uid);
  } else if (e.key === ' ') {
    e.preventDefault();
    toggleSelection(tile.dataset.uid, true);
    anchorUid = tile.dataset.uid;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openViewer(tile.dataset.uid);
  }
});

grid.addEventListener('dragstart', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  const u = tile.dataset.uid;
  // Dragging a selected page moves the whole selection with it.
  dragUids = state.sel.has(u) ? state.pages.filter((p) => state.sel.has(p.uid)).map((p) => p.uid) : [u];
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', u);
  requestAnimationFrame(() => {
    for (const t of tiles()) if (dragUids.includes(t.dataset.uid)) t.classList.add('dragging');
  });
});

grid.addEventListener('dragend', () => {
  dragUids = [];
  clearDropHints();
  for (const t of tiles()) t.classList.remove('dragging');
});

// Files dragged in from outside are dropped between pages too, at the same
// marker a page being moved shows.
const draggingFiles = (e) => !dragUids.length && e.dataTransfer?.types.includes('Files');

grid.addEventListener('dragover', (e) => {
  const files = draggingFiles(e);
  if (!dragUids.length && !files) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = files ? 'copy' : 'move';
  const tile = e.target.closest('.tile');
  clearDropHints();
  if (!tile) { if (files) addTile.classList.add('drop-here'); return; }
  const box = tile.getBoundingClientRect();
  tile.classList.add(e.clientX < box.left + box.width / 2 ? 'drop-before' : 'drop-after');
});

/** Where the marker says the drop goes, as a page position. */
function hintedIndex() {
  const hinted = $('.tile.drop-before, .tile.drop-after', grid);
  if (!hinted) return state.pages.length;
  const idx = tiles().indexOf(hinted);
  return hinted.classList.contains('drop-after') ? idx + 1 : idx;
}

grid.addEventListener('dragleave', (e) => {
  if (!grid.contains(e.relatedTarget)) clearDropHints();
});

grid.addEventListener('drop', (e) => {
  if (draggingFiles(e) && e.dataTransfer.files.length) {
    e.preventDefault();   // tells the window-wide handler it is taken care of
    const at = hintedIndex();
    clearDropHints();
    intake(e.dataTransfer.files, at);
    return;
  }
  if (!dragUids.length) return;
  e.preventDefault();
  const at = hintedIndex();
  clearDropHints();
  const moving = state.pages.filter((p) => dragUids.includes(p.uid));
  if (moving.length) movePages(moving, at);
});

function clearDropHints() {
  for (const t of tiles()) t.classList.remove('drop-before', 'drop-after');
  addTile.classList.remove('drop-here');
}

grid.addEventListener('scroll', closeMenu, { passive: true });

on('pages', renderGrid);
on('sel', renderSelection);
on('sources', () => { anchorUid = null; });
