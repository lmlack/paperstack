// The Organize panel: bulk page actions and the source-file list.

import { $, el, fmtBytes } from '../lib/dom.js';
import {
  state, on, setSelection, targetPages, rotatePages,
  duplicatePages, reversePages, moveToEnd, movePagesTo, liveSources,
} from '../state.js';
import { setThumbScale, deleteWithUndo, sourceColor, insertChoices } from '../ui/pagegrid.js';
import { openMenu, closeMenu } from '../ui/menu.js';
import { undoable } from '../ui/history.js';
import { toast } from '../ui/feedback.js';

const TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';

export function initOrganize() {
  $('#btnSelectAll').onclick = () => setSelection(state.pages.map((p) => p.uid));
  $('#btnSelectNone').onclick = () => setSelection([]);

  $('#btnRotL').onclick = () => rotatePages(targetPages(), -90);
  $('#btnRotR').onclick = () => rotatePages(targetPages(), 90);
  $('#btnDuplicate').onclick = () => duplicatePages(targetPages());
  $('#btnDelete').onclick = () => deleteWithUndo(targetPages());

  // The same actions, in the grid's header while pages are selected.
  $('#selRotL').onclick = () => rotatePages(targetPages(), -90);
  $('#selRotR').onclick = () => rotatePages(targetPages(), 90);
  $('#selDup').onclick = () => duplicatePages(targetPages());
  $('#selDel').onclick = () => deleteWithUndo(targetPages());
  $('#selMove').onclick = () => openMoveMenu($('#selMove'));
  $('#selInsert').onclick = () => {
    const chosen = targetPages();
    const after = state.pages.indexOf(chosen.at(-1)) + 1;
    openMenu($('#selInsert'), insertChoices(after), { label: `Insert after page ${after}` });
  };
  $('#btnMoveFront').onclick = () => moveToEnd(targetPages(), 'front');
  $('#btnMoveBack').onclick = () => moveToEnd(targetPages(), 'back');
  $('#btnReverse').onclick = () => reversePages();

  // The panel's own "move to page", for the pages selected in the grid.
  const moveBox = $('#moveTo');
  const moveSelected = () => {
    const pages = selectedPages();
    if (!pages) return;
    const number = readPageNumber(moveBox);
    if (number) moveTo(pages, number);
  };
  $('#btnMoveTo').onclick = moveSelected;
  moveBox.addEventListener('input', () => moveBox.setCustomValidity(''));
  moveBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); moveSelected(); } });
  const syncMove = () => {
    const n = state.sel.size;
    moveBox.max = String(state.pages.length);
    $('#btnMoveTo').disabled = !n;
    $('#moveToLabel').textContent = n > 1 ? `Move the ${n} selected pages to page` : 'Move the selected page to page';
  };
  on('sel', syncMove);
  on('pages', syncMove);
  syncMove();

  const zoom = $('#zoom');
  zoom.addEventListener('input', () => setThumbScale(Number(zoom.value)));
  setThumbScale(Number(zoom.value));

  on('sources', renderFileList);
  on('pages', renderFileList);
  renderFileList();
}

/** The selected pages, or null after saying there are none. */
function selectedPages() {
  const chosen = state.pages.filter((p) => state.sel.has(p.uid));
  if (!chosen.length) toast('Select the pages to move first.', 'err');
  return chosen.length ? chosen : null;
}

/**
 * Moves pages so the first of them becomes page `number` (1-based), and says
 * where they went, with Undo on the message.
 */
function moveTo(pages, number) {
  const n = pages.length;
  const what = n === 1 ? `page ${state.pages.indexOf(pages[0]) + 1}` : `${n} pages`;
  const last = state.pages.length - n + 1;    // the furthest the first of them can go
  const to = Math.max(1, Math.min(last, number));
  if (!movePagesTo(pages, to - 1)) {
    toast(n === 1 ? `That is already page ${to}.` : `Those are already pages ${to}–${to + n - 1}.`);
    return;
  }
  undoable(n === 1 ? `Moved ${what} to page ${to}.` : `Moved ${what} to pages ${to}–${to + n - 1}.`);
}

/** Reads a page number box, flagging anything outside 1 to the page count. */
function readPageNumber(input) {
  const value = Math.round(Number(input.value));
  if (input.value !== '' && value >= 1 && value <= state.pages.length) return value;
  input.setCustomValidity(`Pick a page from 1 to ${state.pages.length}.`);
  input.reportValidity();
  return null;
}

/**
 * "Move to…" above the grid: a small form for sending the selected pages to
 * any page number, or straight to the start or end. Dragging works too; this
 * is for when the spot is far away.
 */
function openMoveMenu(anchor) {
  const moving = selectedPages();
  if (!moving) return;
  const n = moving.length;
  const what = n === 1 ? `page ${state.pages.indexOf(moving[0]) + 1}` : `${n} pages`;
  const done = (number) => { closeMenu(); moveTo(moving, number); };

  const input = el('input', {
    type: 'number', min: '1', max: String(state.pages.length), inputmode: 'numeric',
    value: '1', 'aria-label': 'Page number to move to',
  });
  const go = () => { const v = readPageNumber(input); if (v) done(v); };
  input.addEventListener('input', () => input.setCustomValidity(''));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });

  const form = el('div', { class: 'moveform' },
    el('div', { class: 'popmenu-title', text: `Move ${what}` }),
    el('label', { class: 'moveform-row' }, el('span', { text: 'To page' }), input,
      el('button', { class: 'btn tiny primary', text: 'Move', onclick: go })),
    el('div', { class: 'moveform-quick' },
      el('button', { class: 'btn tiny ghost', text: 'To the start', onclick: () => done(1) }),
      el('button', { class: 'btn tiny ghost', text: 'To the end', onclick: () => done(state.pages.length) })));
  openMenu(anchor, [form], { label: `Move ${what}` });
  input.select();
}

/** Duplicating pages can push the count above the file's own, so say it plainly. */
function describeUse(used, total) {
  if (used === total) return `${total} page${total === 1 ? '' : 's'}`;
  if (used > total) return `${used} pages from a ${total}-page file`;
  return `${used} of ${total} pages`;
}

function renderFileList() {
  const host = $('#filelist');
  host.textContent = '';
  const files = liveSources();
  if (!files.length) return;

  host.append(el('div', { class: 'lbl', text: `Open files (${files.length})` }));
  if (files.length > 1) {
    host.append(el('p', { class: 'hint', text: 'Click a file to select its pages, then drag them into place or use Move to… above the pages.' }));
  }
  for (const src of files) {
    const used = state.pages.filter((p) => p.srcId === src.id).length;
    // Clicking a file picks out its pages, ready to drag or "Move to…".
    host.append(el('div', { class: 'row' },
      el('button', {
        class: 'row-open',
        title: 'Select this file’s pages',
        onclick: () => setSelection(state.pages.filter((p) => p.srcId === src.id).map((p) => p.uid)),
      },
      files.length > 1 ? el('i', { class: 'srcdot', style: `background:${sourceColor(src.id)}` }) : null,
      el('div', { class: 'grow' },
        el('div', { text: src.name, title: src.name }),
        el('div', { class: 'sub', text: `${describeUse(used, src.pageCount)} · ${fmtBytes(src.size)}` }))),
      el('button', {
        title: 'Remove this file’s pages',
        html: TRASH,
        onclick: () => {
          const mine = state.pages.filter((p) => p.srcId === src.id);
          if (mine.length === state.pages.length) {
            toast('That would empty the document. Use Start over instead.', 'err');
            return;
          }
          deleteWithUndo(mine);
        },
      })));
  }
}
