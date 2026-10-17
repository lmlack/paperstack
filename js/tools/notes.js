// Notes. Two kinds, chosen per note:
//   on the page  text written onto the page itself, optionally on a colored
//                card. Everyone sees it, every app shows it, it prints.
//   sticky note  a real PDF comment: a note icon that opens in Preview,
//                Acrobat and the like, stays editable there, and does not print.
// Both are stamps like watermarks, so they stay removable until export.

import { $, el, segment, bindRange, uid } from '../lib/dom.js';
import { state, on, addStamps, removeStampGroup, numberOf } from '../state.js';
import { noteMetrics, displayInfo } from '../assemble.js';
import { NOTE, wrapText, noteBox } from '../lib/textwrap.js';
import { toast } from '../ui/feedback.js';
import { openViewer } from '../ui/viewer.js';
import { describeStamp } from '../ui/arrange.js';

// 'ink' is a line drawn in the viewer; it is listed here so it can be removed.
export const NOTE_TYPES = new Set(['note', 'comment', 'ink']);

const HINTS = {
  note: 'Written onto the page, so it shows in every PDF app and prints.',
  comment: 'A note icon that opens when clicked in Preview, Acrobat and most PDF apps. It stays editable there and does not print.',
};

const TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';

let kind = 'note';
let bg = '#fff3a8';

export function initNotes() {
  segment($('#ntKind'), (v) => {
    kind = v;
    $('#ntStyle').hidden = v !== 'note';
    $('#ntCommentStyle').hidden = v !== 'comment';
    $('#ntKindHint').textContent = HINTS[v];
  });
  $('#ntKindHint').textContent = HINTS[kind];
  segment($('#ntBg'), (v) => { bg = v === 'none' ? null : v; });
  bindRange($('#ntSize'), $('#ntSizeOut'), (v) => `${v} pt`);

  $('#btnNtPlace').onclick = openPlacement;
  on('pages', () => { refreshPageMenu(); renderNoteList(); });
  // Picking a single page in the grid makes it the note's page.
  on('sel', () => {
    if (state.sel.size === 1) $('#ntPage').value = [...state.sel][0];
  });
  refreshPageMenu();
  renderNoteList();
}

function refreshPageMenu() {
  const menu = $('#ntPage');
  const previous = menu.value;
  menu.textContent = '';
  state.pages.forEach((page, i) => menu.append(el('option', { value: page.uid, text: `Page ${i + 1}` })));
  if ([...menu.options].some((o) => o.value === previous)) menu.value = previous;
}

async function openPlacement() {
  const page = state.pages.find((p) => p.uid === $('#ntPage').value);
  if (!page) { toast('Add a page first.', 'err'); return; }
  const typed = $('#ntText').value.replace(/\s+$/, '');
  if (!typed.trim()) { toast('Write the note first.', 'err'); return; }

  if (kind === 'comment') await placeComment(page, typed);
  else await placeNote(page, typed);
}

/**
 * Writes the note onto the page near the top, as wide as its longest line but
 * no more than half the page, then opens the page with it selected so it can
 * be dragged into place and pulled wider or narrower.
 */
async function placeNote(page, typed) {
  const font = $('#ntFont').value;
  const size = Number($('#ntSize').value);
  const color = $('#ntColor').value;
  const metrics = await noteMetrics(font);
  const text = metrics.clean(typed);
  const measure = (s) => metrics.measure(s, size);
  const pad = size * NOTE.pad;
  const { w: wPt, h: hPt } = await displayInfo(page);

  // A little slack, since the screen font may run a hair wider than the PDF's.
  const natural = Math.max(...text.split('\n').map(measure)) + 2 * pad + size * 0.5;
  const widthPt = Math.max(size * 3 + 2 * pad, Math.min(natural, wPt * 0.5));
  const lines = wrapText(text, widthPt - 2 * pad, measure);
  const { height } = noteBox(lines, size, widthPt);

  const [stamp] = addStamps([page], [{
    group: uid('note'),
    type: 'note',
    text,
    lines,
    font,
    size,
    color,
    bg,
    u: 0.5,
    v: Math.max(height / hPt / 2, 1 - 0.12 - height / hPt / 2),
    w: widthPt / wPt,
    rot: 0,
    opacity: 1,
  }], 'Add a note');
  $('#ntText').value = '';
  openViewer(page.uid, { pick: stamp.id });
  if (text !== typed) toast('Some characters (like emoji) cannot be written into a PDF this way and became “?”. A sticky note keeps them.', 'err', 6500);
  else toast(`Note added to page ${numberOf(page)}. Drag it into place, or pull its corner to rewrap it.`, 'ok', 5000, null, 'placed');
}

async function placeComment(page, text) {
  const [stamp] = addStamps([page], [{
    group: uid('comment'),
    type: 'comment',
    text,
    color: $('#ntIconColor').value,
    created: Date.now(),
    u: 0.88,
    v: 0.9,
    rot: 0,
    opacity: 1,
  }], 'Add a sticky note');
  $('#ntText').value = '';
  openViewer(page.uid, { pick: stamp.id });
  toast(`Sticky note added to page ${numberOf(page)}. Drag the icon to the spot it is about.`, 'ok', 5000, null, 'placed');
}

function renderNoteList() {
  const host = $('#noteList');
  host.textContent = '';
  const rows = [];
  const seen = new Set();
  state.pages.forEach((page, i) => {
    for (const stamp of page.stamps) {
      if (!NOTE_TYPES.has(stamp.type) || seen.has(stamp.group)) continue;
      seen.add(stamp.group);
      const name = describeStamp(stamp);
      rows.push(el('div', { class: 'row' },
        el('button', { class: 'row-open', title: 'Show it on the page', onclick: () => openViewer(page.uid, { pick: stamp.id }) },
          el('span', { class: 'swatch', style: `background:${stamp.type === 'note' ? (stamp.bg ?? stamp.color) : stamp.color}` }),
          el('div', { class: 'grow' },
            el('div', { text: stamp.type === 'ink' ? 'Drawing' : stamp.text.split('\n')[0] }),
            el('div', { class: 'sub', text: `Page ${i + 1} · ${name.toLowerCase()}` }))),
        el('button', { title: 'Remove', 'aria-label': `Remove ${name.toLowerCase()} on page ${i + 1}`, html: TRASH, onclick: () => removeStampGroup(stamp.group) })));
    }
  });
  if (!rows.length) return;
  host.append(el('hr'), el('div', { class: 'lbl', text: `Notes (${rows.length})` }), ...rows);
}
