// Bringing pages in: files (PDFs and images) and blank pages, either at the
// end or at a chosen spot in the document, e.g. dropped between two pages.

import { $ } from '../lib/dom.js';
import { state, addPdf, addImageAsPage, addBlankPage, PAPER } from '../state.js';
import { displayInfo } from '../assemble.js';
import { toast, withBusy } from './feedback.js';
import { undoable } from './history.js';
import { openViewer } from './viewer.js';

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImage = (f) => f.type.startsWith('image/');

/** "before page 3", "at the end": where `at` puts things, for messages. */
function describeSpot(at) {
  if (at == null || at >= state.pages.length) return 'at the end';
  return `before page ${at + 1}`;
}

/**
 * Adds files at page position `at` (0-based), or at the end with null. They
 * go in in the order given, one after another.
 */
export async function intake(files, at = null) {
  const list = [...files].filter((f) => isPdf(f) || isImage(f));
  const ignored = files.length - list.length;
  if (!list.length) {
    toast('Drop a PDF (or an image to add as a page).', 'err');
    return;
  }

  const wasEmpty = !state.pages.length;
  const where = describeSpot(at);
  let cursor = at;
  let added = 0;

  await withBusy('Opening…', async (ui) => {
    const failures = [];
    for (const [i, file] of list.entries()) {
      ui.label(`${isPdf(file) ? 'Opening' : 'Converting'} ${file.name}…`);
      ui.step(i, list.length);
      try {
        const n = isPdf(file) ? await addPdf(file, cursor) : await addImageAsPage(file, cursor);
        added += n;
        if (cursor != null) cursor += n;
      } catch (err) {
        failures.push(isPdf(file) ? err.message : `${file.name} could not be read.`);
      }
    }
    for (const message of failures) toast(message, 'err', 7000);
  });

  if (ignored) toast(`Skipped ${ignored} file${ignored === 1 ? '' : 's'} that wasn’t a PDF or image.`);
  if (added && !wasEmpty) undoable(`Added ${added} page${added === 1 ? '' : 's'} ${where}.`);
}

/* ───────────────────────── choosing files for a spot ───────────────────────── */

let pendingAt = null;   // where the next files from the picker go

/** Opens the file picker; what is chosen goes in at `at` (or the end). */
export function pickFiles(at = null) {
  pendingAt = at;
  $('#fileInput').click();
}

export function initIntake() {
  $('#fileInput').addEventListener('change', (e) => {
    const at = pendingAt;
    pendingAt = null;
    intake(e.target.files, at);
    e.target.value = '';
  });
  // The plain "Add files" label opens the picker without going through
  // pickFiles, so anything it brings goes at the end.
  $('#addFilesBtn').addEventListener('click', () => { pendingAt = null; });
  $('#imageInput').addEventListener('change', (e) => {
    intake(e.target.files);
    e.target.value = '';
  });

  for (const button of document.querySelectorAll('[data-blank]')) {
    button.onclick = () => startBlank(PAPER[button.dataset.blank]);
  }
}

/* ───────────────────────── blank pages ───────────────────────── */

/** From the empty screen: one blank page, opened in the editor to write on. */
async function startBlank(size) {
  const page = await withBusy('Making a blank page…', () => addBlankPage(size));
  if (page) openViewer(page.uid);
}

/**
 * Adds a blank page at `at`, the same size as the page before it (or after
 * it, at the very front), so it sits naturally among its neighbors.
 */
export async function insertBlank(at) {
  const neighbor = state.pages[at - 1] ?? state.pages[at] ?? null;
  let size = PAPER.letter;
  if (neighbor) {
    const { w, h } = await displayInfo(neighbor);
    size = { w, h };
  }
  const page = await withBusy('Adding a blank page…', () => addBlankPage(size, at));
  if (!page) return;
  toast(`Blank page added as page ${state.pages.indexOf(page) + 1}.`, 'ok', 6500,
    { label: 'Edit it', run: () => openViewer(page.uid) }, 'history');
}
