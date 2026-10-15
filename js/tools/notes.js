// Notes. Two kinds, chosen per note:
//   on the page  text written onto the page itself, optionally on a colored
//                card. Everyone sees it, every app shows it, it prints.
//   sticky note  a real PDF comment: a note icon that opens in Preview,
//                Acrobat and the like, stays editable there, and does not print.
// Both are stamps like watermarks, so they stay removable until export.

import { $, el, segment, bindRange, uid } from '../lib/dom.js';
import { state, on, addStamps, removeStampGroup } from '../state.js';
import { noteMetrics } from '../assemble.js';
import { NOTE, wrapText } from '../lib/textwrap.js';
import { toast } from '../ui/feedback.js';
import { place } from '../ui/place.js';

export const NOTE_TYPES = new Set(['note', 'comment']);

const FAMILY = {
  Helvetica: 'Helvetica, Arial, sans-serif',
  HelveticaBold: 'Helvetica, Arial, sans-serif',
  TimesRoman: 'Times, "Times New Roman", serif',
  Courier: '"Courier New", Courier, monospace',
};

const HINTS = {
  note: 'Written onto the page, so it shows in every PDF app and prints.',
  comment: 'A note icon that opens when clicked in Preview, Acrobat and most PDF apps. It stays editable there and does not print.',
};

const COMMENT_ICON = '<svg viewBox="0 0 24 24"><path d="M5 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-7l-5 4v-4H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M8 8.5h8M8 12h5"/></svg>';
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

async function placeNote(page, typed) {
  const font = $('#ntFont').value;
  const size = Number($('#ntSize').value);
  const color = $('#ntColor').value;
  const metrics = await noteMetrics(font);
  const text = metrics.clean(typed);
  const measure = (s) => metrics.measure(s, size);
  const pad = size * NOTE.pad;

  let widthPt;
  let pageWidthPt;
  let lines;
  const spot = await place(page, {
    title: 'Position your note',
    confirm: 'Place note',
    hint: 'Drag to move, or pull the corner to make the note wider or narrower',
    build(item, stage) {
      pageWidthPt = stage.w / stage.scale;
      const card = el('div', { class: 'note-card' });
      Object.assign(card.style, {
        fontFamily: FAMILY[font],
        fontWeight: font === 'HelveticaBold' ? '700' : '400',
        fontSize: `${size * stage.scale}px`,
        lineHeight: String(NOTE.line),
        padding: `${pad * stage.scale}px`,
        color,
        background: bg ?? 'transparent',
      });
      item.prepend(card);
      item.classList.add('is-note');

      const layout = (wPt) => {
        widthPt = Math.max(size * 3 + 2 * pad, Math.min(pageWidthPt, wPt));
        lines = wrapText(text, widthPt - 2 * pad, measure);
        card.textContent = lines.join('\n');
        item.style.width = `${widthPt * stage.scale}px`;
      };
      // Start as wide as the longest typed line, but no wider than half the page.
      // A little slack, since the screen font may run a hair wider than the PDF's.
      const natural = Math.max(...text.split('\n').map(measure)) + 2 * pad + size * 0.5;
      layout(Math.min(natural, pageWidthPt * 0.5));
      // The window is still hidden here, so position from the layout, not offsetWidth.
      item.style.left = `${(stage.w - widthPt * stage.scale) / 2}px`;
      item.style.top = `${stage.h * 0.12}px`;
      return { resize: (px) => layout(px / stage.scale) };
    },
  });
  if (!spot) return;

  addStamps([page], [{
    group: uid('note'),
    type: 'note',
    text,
    lines,
    font,
    size,
    color,
    bg,
    u: spot.u,
    v: spot.v,
    w: widthPt / pageWidthPt,   // from the layout, not the dashed frame around it
    rot: 0,
    opacity: 1,
  }]);
  if (text !== typed) toast('Some characters (like emoji) cannot be written into a PDF this way and became “?”. A sticky note keeps them.', 'err', 6500);
  else toast(`Note placed on page ${state.pages.indexOf(page) + 1}.`, 'ok');
}

async function placeComment(page, text) {
  const color = $('#ntIconColor').value;
  const spot = await place(page, {
    title: 'Position your sticky note',
    confirm: 'Place sticky note',
    hint: 'Drag the icon to the spot the note is about',
    build(item, stage) {
      const side = Math.max(28, 20 * stage.scale);
      item.classList.add('is-comment');
      item.prepend(el('div', { class: 'comment-pin', style: `background:${color}`, html: COMMENT_ICON, title: text }));
      Object.assign(item.style, {
        width: `${side}px`,
        height: `${side}px`,
        left: `${stage.w * 0.85 - side / 2}px`,
        top: `${stage.h * 0.08}px`,
      });
    },
  });
  if (!spot) return;

  addStamps([page], [{
    group: uid('comment'),
    type: 'comment',
    text,
    color,
    created: Date.now(),
    u: spot.u,
    v: spot.v,
    rot: 0,
    opacity: 1,
  }]);
  toast(`Sticky note placed on page ${state.pages.indexOf(page) + 1}.`, 'ok');
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
      rows.push(el('div', { class: 'row' },
        el('span', { class: 'swatch', style: `background:${stamp.type === 'note' ? (stamp.bg ?? stamp.color) : stamp.color}` }),
        el('div', { class: 'grow' },
          el('div', { text: stamp.text.split('\n')[0] }),
          el('div', { class: 'sub', text: `Page ${i + 1} · ${stamp.type === 'note' ? 'on the page' : 'sticky note'}` })),
        el('button', { title: 'Remove', 'aria-label': 'Remove note', html: TRASH, onclick: () => removeStampGroup(stamp.group) })));
    }
  });
  if (!rows.length) return;
  host.append(el('hr'), el('div', { class: 'lbl', text: `Notes (${rows.length})` }), ...rows);
}
