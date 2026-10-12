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

/** Appends every page of a PDF file to the end of the workspace. */
export async function addPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const src = await registerSource(file.name, bytes);
  for (let i = 0; i < src.pageCount; i++) state.pages.push(makePage(src.id, i));
  if (!state.outName) state.outName = file.name;
  emit('sources', 'pages');
  return src;
}

/**
 * Images become a one-page PDF before they enter the workspace, so from that
 * point on every page in the app is simply "a page of some source PDF".
 */
export async function addImageAsPage(file) {
  const { bytes, mime } = await normalizeImage(file);
  const doc = await PDFDocument.create();
  const image = mime === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const page = doc.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  const pdfBytes = await doc.save();
  const src = await registerSource(file.name, pdfBytes);
  state.pages.push(makePage(src.id, 0));
  emit('sources', 'pages');
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
  for (const p of pages) p.rot = (((p.rot + delta) % 360) + 360) % 360;
  emit('pages');
}

export function deletePages(pages) {
  const doomed = new Set(pages.map((p) => p.uid));
  state.pages = state.pages.filter((p) => !doomed.has(p.uid));
  for (const u of doomed) state.sel.delete(u);
  pruneSources();
  emit('pages', 'sel', 'sources');
}

export function duplicatePages(pages) {
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

export function reorder(uids) {
  const index = new Map(state.pages.map((p) => [p.uid, p]));
  state.pages = uids.map((u) => index.get(u)).filter(Boolean);
  emit('pages');
}

export function reversePages() {
  state.pages.reverse();
  emit('pages');
}

export function moveToEnd(pages, where) {
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
  emit('sources', 'pages', 'sel');
}

/** Drops sources that no longer back any page, freeing their worker and thumbnails. */
function pruneSources() {
  const live = new Set(state.pages.map((p) => p.srcId));
  for (const [id, src] of state.sources) {
    if (live.has(id)) continue;
    forgetThumbnails(id);
    void closeDocument(src.pdfjs);
    state.sources.delete(id);
  }
}

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

export function addStamps(pages, stamps) {
  for (const p of pages) p.stamps.push(...stamps.map((s) => ({ ...s, id: uid('st') })));
  emit('pages');
}

export function removeStampGroup(group) {
  for (const p of state.pages) p.stamps = p.stamps.filter((s) => s.group !== group);
  emit('pages');
}

/** Stamp groups currently in the document, with a page count for each. */
export function stampGroups() {
  const groups = new Map();
  for (const p of state.pages) {
    for (const s of p.stamps) {
      if (!groups.has(s.group)) groups.set(s.group, { group: s.group, stamp: s, pages: new Set() });
      groups.get(s.group).pages.add(p.uid);
    }
  }
  return [...groups.values()].map((g) => ({ ...g, count: g.pages.size }));
}

export const totalBytes = () => [...state.sources.values()].reduce((n, s) => n + s.size, 0);
