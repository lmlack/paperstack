// The page grid: thumbnails, selection, drag-to-reorder, per-page actions and
// live stamp previews. Thumbnails render lazily as tiles scroll into view.

import { $, el } from '../lib/dom.js';
import { thumbnail, rotateCanvas } from '../pdfjs.js';
import { paintStamps } from './stamps.js';
import { openViewer } from './viewer.js';
import {
  state, on, srcOf, rotatePages, deletePages, duplicatePages, movePages,
  toggleSelection, selectRangeTo,
} from '../state.js';

const grid = $('#pagegrid');
const selCount = $('#selCount');

const ICON = {
  left:  '<svg viewBox="0 0 24 24"><path d="M9 4 4.5 8.5 9 13"/><path d="M4.5 8.5h8A6.5 6.5 0 0 1 19 15v1"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="m15 4 4.5 4.5L15 13"/><path d="M19.5 8.5h-8A6.5 6.5 0 0 0 5 15v1"/></svg>',
  copy:  '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a2 2 0 0 0-2 2v9"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
};

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

const drawStamps = (tile, page) =>
  paintStamps($('.stamps', tile), page, Number(tile.dataset.pageWidthPt));

/* ───────────────────────── rendering the grid ───────────────────────── */

function tileFor(page, number) {
  const src = srcOf(page);
  const tile = el('div', { class: 'tile', 'data-uid': page.uid, draggable: 'true' });

  const thumb = el('div', { class: 'thumb', tabindex: '0', role: 'button',
    'aria-label': `Page ${number}${page.rot ? `, rotated ${page.rot}°` : ''}` });
  thumb.append(
    el('div', { class: 'skel' }),
    el('div', { class: 'stamps' }),
    el('button', {
      class: 'expand',
      title: `View page ${number} full size`,
      'aria-label': `View page ${number} full size`,
      onclick: (e) => { e.stopPropagation(); openViewer(page.uid); },
    }, el('span', { html: ICON.expand })),
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
      onclick: (e) => { e.stopPropagation(); deletePages([page]); } }),
  );

  const bar = el('div', { class: 'tile-bar' },
    el('span', { class: 'num', text: String(number) }),
    el('span', { class: 'src', text: state.sources.size > 1 ? src.name : '', title: src.name }),
    acts);

  tile.append(thumb, bar);
  return tile;
}

export function renderGrid() {
  const existing = new Map([...grid.children].map((n) => [n.dataset.uid, n]));
  const next = [];

  state.pages.forEach((page, i) => {
    let tile = existing.get(page.uid);
    if (tile) {
      existing.delete(page.uid);
      $('.num', tile).textContent = String(i + 1);
      $('.src', tile).textContent = state.sources.size > 1 ? srcOf(page).name : '';
      const thumb = $('.thumb', tile);
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
  grid.append(...next);
  renderSelection();
}

export function renderSelection() {
  for (const tile of grid.children) tile.classList.toggle('sel', state.sel.has(tile.dataset.uid));
  const n = state.sel.size;
  selCount.textContent = n ? `${n} selected` : '';
}

export function setThumbScale(px) {
  grid.style.setProperty('--tile', `${px}px`);
  const want = px <= 160 ? 240 : px <= 240 ? 320 : 460;
  if (want !== thumbWidth) {
    thumbWidth = want;
    for (const tile of grid.children) { seen.delete(tile); paintThumb(tile); }
  }
}

/* ───────────────────────── interaction ───────────────────────── */

grid.addEventListener('dblclick', (e) => {
  const tile = e.target.closest('.tile');
  if (tile && !e.target.closest('.acts')) openViewer(tile.dataset.uid);
});

grid.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile || e.target.closest('.acts')) return;
  const u = tile.dataset.uid;
  if (e.shiftKey && anchorUid) selectRangeTo(u, anchorUid);
  else { toggleSelection(u, e.metaKey || e.ctrlKey); anchorUid = u; }
});

grid.addEventListener('keydown', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    toggleSelection(tile.dataset.uid, e.metaKey || e.ctrlKey);
    anchorUid = tile.dataset.uid;
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
    for (const t of grid.children) if (dragUids.includes(t.dataset.uid)) t.classList.add('dragging');
  });
});

grid.addEventListener('dragend', () => {
  dragUids = [];
  clearDropHints();
  for (const t of grid.children) t.classList.remove('dragging');
});

grid.addEventListener('dragover', (e) => {
  if (!dragUids.length) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const tile = e.target.closest('.tile');
  clearDropHints();
  if (!tile) return;
  const box = tile.getBoundingClientRect();
  tile.classList.add(e.clientX < box.left + box.width / 2 ? 'drop-before' : 'drop-after');
});

grid.addEventListener('dragleave', (e) => {
  if (!grid.contains(e.relatedTarget)) clearDropHints();
});

grid.addEventListener('drop', (e) => {
  if (!dragUids.length) return;
  e.preventDefault();
  const hinted = $('.drop-before, .drop-after', grid);
  clearDropHints();
  const moving = state.pages.filter((p) => dragUids.includes(p.uid));
  if (!moving.length) return;

  let at = state.pages.length;
  if (hinted) {
    const idx = [...grid.children].indexOf(hinted);
    at = hinted.classList.contains('drop-after') ? idx + 1 : idx;
  }
  movePages(moving, at);
});

function clearDropHints() {
  for (const t of grid.children) t.classList.remove('drop-before', 'drop-after');
}

on('pages', renderGrid);
on('sel', renderSelection);
on('sources', () => { anchorUid = null; });
