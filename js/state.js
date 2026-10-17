// The whole workspace lives here: the PDFs you opened, the page order you are
// building, and the stamps queued onto those pages. Nothing in this file touches
// the DOM. The UI subscribes to change events and re-reads the state.

import { PDFDocument } from '../vendor/pdf-lib.esm.min.js';
import { openDocument, forgetThumbnails, closeDocument } from './pdfjs.js';
import { uid } from './lib/dom.js';

export const state = {
  /** srcId -> { id, name, size, bytes, pdfjs, pageCount } */
  sources: new Map(),
  /** ordered page list: { uid, srcId, index, rot, stamps[] } */
  pages: [],
  /** assetId -> { id, bytes, mime, w, h, url } for watermark + signature images */
  assets: new Map(),
  /** selected page uids */
  sel: new Set(),
  outName: '',
};

/* ───────────────────────── events ───────────────────────── */

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(...events) {
  for (const event of events) for (const fn of listeners.get(event) ?? []) fn();
}

/* ───────────────────────── reading files ───────────────────────── */

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];   // "%PDF"

async function registerSource(name, bytes) {
  if (!PDF_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new Error(`${name} does not look like a PDF.`);
  }
  let pdfjsDoc;
  try {
    pdfjsDoc = await openDocument(bytes);
  } catch (err) {
    if (err?.name === 'PasswordException') {
      throw new Error(`${name} is password-protected. Remove the password first.`);
    }
    throw new Error(`${name} could not be opened. It may be damaged.`);
  }
  const src = {
    id: uid('src'),
    name,
    size: bytes.length,
    bytes,
    pdfjs: pdfjsDoc,
    pageCount: pdfjsDoc.numPages,
  };
  state.sources.set(src.id, src);
  return src;
}

/** Puts pages into the workspace at `at`, or at the end. */
function insertPages(pages, at) {
  const where = at == null ? state.pages.length : Math.max(0, Math.min(state.pages.length, at));
  state.pages.splice(where, 0, ...pages);
}

/**
 * Adds every page of a PDF file, at page position `at` (0-based) or at the
 * end. Returns the number of pages added.
 */
export async function addPdf(file, at = null) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const src = await registerSource(file.name, bytes);
  record(`Add ${file.name}`);
  const pages = Array.from({ length: src.pageCount }, (_, i) => makePage(src.id, i));
  insertPages(pages, at);
  if (!state.outName) state.outName = file.name;
  emit('sources', 'pages');
  return pages.length;
}

/**
 * Images become a one-page PDF before they enter the workspace, so from that
 * point on every page in the app is simply "a page of some source PDF".
 */
export async function addImageAsPage(file, at = null) {
  const { bytes, mime } = await normalizeImage(file);
  const doc = await PDFDocument.create();
  const image = mime === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const page = doc.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  const pdfBytes = await doc.save();
  const src = await registerSource(file.name, pdfBytes);
  record(`Add ${file.name}`);
  insertPages([makePage(src.id, 0)], at);
  if (!state.outName) state.outName = file.name.replace(/\.\w+$/, '');
  emit('sources', 'pages');
  return 1;
}

export const PAPER = {
  letter: { name: 'Letter', w: 612, h: 792 },
  a4: { name: 'A4', w: 595.28, h: 841.89 },
};

// One small source per blank page size, shared by every blank page of that
// size, the way a duplicated page shares its source.
const blanks = new Map();   // `${w}x${h}` -> srcId

async function blankSource(w, h) {
  const key = `${Math.round(w)}x${Math.round(h)}`;
  const known = blanks.get(key);
  if (known && state.sources.has(known)) return known;
  const doc = await PDFDocument.create();
  doc.addPage([w, h]);
  const paper = Object.values(PAPER).find((p) => `${Math.round(p.w)}x${Math.round(p.h)}` === key);
  const src = await registerSource(`Blank ${paper ? paper.name : 'page'}`, await doc.save());
  blanks.set(key, src.id);
  return src.id;
}

/**
 * Adds a blank page of `w` by `h` points at position `at` (or the end).
 * Returns the new page, so it can be opened straight away.
 */
export async function addBlankPage({ w, h }, at = null) {
  const srcId = await blankSource(w, h);
  record('Add a blank page');
  const page = makePage(srcId, 0);
  insertPages([page], at);
  if (!state.outName) state.outName = 'Untitled';
  emit('sources', 'pages');
  return page;
}

const makePage = (srcId, index) => ({ uid: uid('pg'), srcId, index, rot: 0, stamps: [] });

/**
 * pdf-lib only embeds PNG and JPEG, so anything else (WebP, and PNGs we want
 * flattened) is re-encoded through a canvas first.
 */
export async function normalizeImage(file) {
  const mime = file.type;
  if (mime === 'image/png' || mime === 'image/jpeg') {
    return { bytes: new Uint8Array(await file.arrayBuffer()), mime };
  }
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' };
}

/** Stores an image for use as a watermark or signature and measures it. */
export async function addAsset(file) {
  const { bytes, mime } = await normalizeImage(file);
  const blob = new Blob([bytes], { type: mime });
  const bitmap = await createImageBitmap(blob);
  const asset = {
    id: uid('asset'),
    bytes,
    mime,
    w: bitmap.width,
    h: bitmap.height,
    url: URL.createObjectURL(blob),
  };
  bitmap.close?.();
  state.assets.set(asset.id, asset);
  return asset;
}

/** Stores a canvas (the signature pad) as an asset. */
export async function addCanvasAsset(canvas) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const asset = {
    id: uid('asset'),
    bytes,
    mime: 'image/png',
    w: canvas.width,
    h: canvas.height,
    url: URL.createObjectURL(blob),
  };
  state.assets.set(asset.id, asset);
  return asset;
}

/* ───────────────────────── page operations ───────────────────────── */

export const pageByUid = (u) => state.pages.find((p) => p.uid === u);
export const srcOf = (page) => state.sources.get(page.srcId);

/** The pages an action should affect: the selection, or everything if none. */
export function targetPages() {
  const chosen = state.pages.filter((p) => state.sel.has(p.uid));
  return chosen.length ? chosen : state.pages;
}

export function rotatePages(pages, delta) {
  record(pages.length === 1 ? `Rotate page ${numberOf(pages[0])}` : `Rotate ${pages.length} pages`);
  for (const p of pages) p.rot = (((p.rot + delta) % 360) + 360) % 360;
  emit('pages');
}

export function deletePages(pages) {
  record(pages.length === 1 ? `Delete page ${numberOf(pages[0])}` : `Delete ${pages.length} pages`);
  const doomed = new Set(pages.map((p) => p.uid));
  state.pages = state.pages.filter((p) => !doomed.has(p.uid));
  for (const u of doomed) state.sel.delete(u);
  // Sources stay open even with no pages left, so undo can bring them back.
  // They are released by Start over.
  emit('pages', 'sel', 'sources');
}

export function duplicatePages(pages) {
  record(pages.length === 1 ? `Duplicate page ${numberOf(pages[0])}` : `Duplicate ${pages.length} pages`);
  const doomed = new Set(pages.map((p) => p.uid));
  const out = [];
  for (const p of state.pages) {
    out.push(p);
    if (doomed.has(p.uid)) {
      out.push({ ...p, uid: uid('pg'), stamps: p.stamps.map((s) => ({ ...s })) });
    }
  }
  state.pages = out;
  emit('pages');
}

/** Moves the given pages so they sit immediately before index `at`. */
export function movePages(pages, at) {
  record(pages.length === 1 ? 'Move a page' : `Move ${pages.length} pages`);
  const moving = new Set(pages.map((p) => p.uid));
  const anchor = state.pages[at] ?? null;
  const rest = state.pages.filter((p) => !moving.has(p.uid));
  const block = state.pages.filter((p) => moving.has(p.uid));
  const target = anchor && !moving.has(anchor.uid)
    ? rest.indexOf(anchor)
    : anchor === null ? rest.length : clampToNeighbor(rest, state.pages, at, moving);
  rest.splice(target, 0, ...block);
  state.pages = rest;
  emit('pages');
}

/** When the drop anchor is itself being moved, fall back to the nearest page that is not. */
function clampToNeighbor(rest, all, at, moving) {
  for (let i = at; i < all.length; i++) {
    if (!moving.has(all[i].uid)) return rest.indexOf(all[i]);
  }
  return rest.length;
}

/**
 * Moves pages so the first of them ends up at `position` (0-based) in the
 * finished order: "move to page 3" means it is page 3 afterwards. The pages
 * keep their order among themselves.
 */
export function movePagesTo(pages, position) {
  const moving = new Set(pages.map((p) => p.uid));
  const block = state.pages.filter((p) => moving.has(p.uid));
  const rest = state.pages.filter((p) => !moving.has(p.uid));
  const at = Math.max(0, Math.min(rest.length, position));
  if (state.pages.slice(at, at + block.length).every((p, i) => p === block[i])) return false;   // already there
  record(block.length === 1 ? `Move page ${numberOf(block[0])}` : `Move ${block.length} pages`);
  rest.splice(at, 0, ...block);
  state.pages = rest;
  emit('pages');
  return true;
}

export function reorder(uids) {
  record('Reorder pages');
  const index = new Map(state.pages.map((p) => [p.uid, p]));
  state.pages = uids.map((u) => index.get(u)).filter(Boolean);
  emit('pages');
}

export function reversePages() {
  record('Reverse page order');
  state.pages.reverse();
  emit('pages');
}

export function moveToEnd(pages, where) {
  record(`Move to ${where}`);
  const moving = new Set(pages.map((p) => p.uid));
  const block = state.pages.filter((p) => moving.has(p.uid));
  const rest = state.pages.filter((p) => !moving.has(p.uid));
  state.pages = where === 'front' ? [...block, ...rest] : [...rest, ...block];
  emit('pages');
}

/** Replaces the workspace with a single freshly-built PDF (used after compressing). */
export async function replaceWith(name, bytes) {
  for (const src of state.sources.values()) {
    forgetThumbnails(src.id);
    void closeDocument(src.pdfjs);
  }
  state.sources.clear();
  state.pages = [];
  state.sel.clear();
  const src = await registerSource(name, bytes);
  for (let i = 0; i < src.pageCount; i++) state.pages.push(makePage(src.id, i));
  state.outName = name;
  clearHistory();
  emit('sources', 'pages', 'sel');
}

export function reset() {
  for (const src of state.sources.values()) {
    forgetThumbnails(src.id);
    void closeDocument(src.pdfjs);
  }
  for (const asset of state.assets.values()) URL.revokeObjectURL(asset.url);
  state.sources.clear();
  state.assets.clear();
  state.pages = [];
  state.sel.clear();
  state.outName = '';
  clearHistory();
  emit('sources', 'pages', 'sel');
}

/** The open files that still back at least one page, in the order they were added. */
export function liveSources() {
  const used = new Set(state.pages.map((p) => p.srcId));
  return [...state.sources.values()].filter((src) => used.has(src.id));
}

/** A page's 1-based position, for messages. */
export const numberOf = (page) => state.pages.indexOf(page) + 1;

/* ───────────────────────── selection ───────────────────────── */

export function setSelection(uids) {
  state.sel = new Set(uids);
  emit('sel');
}

export function toggleSelection(u, additive) {
  if (!additive) {
    const only = state.sel.size === 1 && state.sel.has(u);
    state.sel = only ? new Set() : new Set([u]);
  } else if (state.sel.has(u)) {
    state.sel.delete(u);
  } else {
    state.sel.add(u);
  }
  emit('sel');
}

export function selectRangeTo(u, anchorUid) {
  const a = state.pages.findIndex((p) => p.uid === anchorUid);
  const b = state.pages.findIndex((p) => p.uid === u);
  if (a < 0 || b < 0) return toggleSelection(u, false);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  state.sel = new Set(state.pages.slice(lo, hi + 1).map((p) => p.uid));
  emit('sel');
}

/* ───────────────────────── stamps ───────────────────────── */

/** Queues marks onto pages. Returns the copies placed on the first page. */
export function addStamps(pages, stamps, label = 'Add a mark') {
  record(label);
  let first = [];
  for (const p of pages) {
    const placed = stamps.map((s) => ({ ...s, id: uid('st') }));
    p.stamps.push(...placed);
    if (p === pages[0]) first = placed;
  }
  emit('pages');
  return first;
}

export const stampById = (page, id) => page?.stamps.find((s) => s.id === id);

/** Changes one mark in place, e.g. after it is dragged. */
export function updateStamp(page, id, patch, label = 'Move a mark') {
  const stamp = stampById(page, id);
  if (!stamp) return;
  record(label);
  Object.assign(stamp, patch);
  emit('pages');
}

export function removeStamp(page, id) {
  if (!stampById(page, id)) return;
  record('Delete a mark');
  page.stamps = page.stamps.filter((s) => s.id !== id);
  emit('pages');
}

export function removeStampGroup(group) {
  record('Remove a mark');
  for (const p of state.pages) p.stamps = p.stamps.filter((s) => s.group !== group);
  emit('pages');
}

/** Stamp groups currently in the document, with a page count for each. */
export function stampGroups() {
  const groups = new Map();
  for (const p of state.pages) {
    for (const s of p.stamps) {
      if (!groups.has(s.group)) groups.set(s.group, { group: s.group, stamp: s, pages: new Set(), first: p });
      groups.get(s.group).pages.add(p.uid);
    }
  }
  return [...groups.values()].map((g) => ({ ...g, count: g.pages.size }));
}

/* ───────────────────────── undo and redo ───────────────────────── */

// Every edit records a snapshot of the page list first: pages are small
// records and stamps are flat objects, so a copy is cheap, and one history
// covers everything from a deleted page to a dragged signature. The PDFs
// themselves are never copied; sources stay open until Start over.

const HISTORY_LIMIT = 150;
const undoStack = [];
const redoStack = [];

const capture = () => ({
  pages: state.pages.map((p) => ({ ...p, stamps: p.stamps.map((s) => ({ ...s })) })),
  sel: [...state.sel],
});

/** Call before changing the workspace; `label` names the change for the undo toast. */
export function record(label) {
  undoStack.push({ label, ...capture() });
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  emit('history');
}

function restore(snap) {
  state.pages = snap.pages;
  const live = new Set(state.pages.map((p) => p.uid));
  state.sel = new Set(snap.sel.filter((u) => live.has(u)));
  emit('sources', 'pages', 'sel', 'history');
}

/** Steps back one change. Returns its label, or null if there was nothing to undo. */
export function undo() {
  const snap = undoStack.pop();
  if (!snap) return null;
  redoStack.push({ label: snap.label, ...capture() });
  restore(snap);
  return snap.label;
}

export function redo() {
  const snap = redoStack.pop();
  if (!snap) return null;
  undoStack.push({ label: snap.label, ...capture() });
  restore(snap);
  return snap.label;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  emit('history');
}

export const totalBytes = () => liveSources().reduce((n, s) => n + s.size, 0);
