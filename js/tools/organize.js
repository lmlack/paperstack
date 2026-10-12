// The Organize panel: bulk page actions and the source-file list.

import { $, el, fmtBytes } from '../lib/dom.js';
import {
  state, on, setSelection, targetPages, rotatePages, deletePages,
  duplicatePages, reversePages, moveToEnd, deletePages as dropPages,
} from '../state.js';
import { setThumbScale } from '../ui/pagegrid.js';
import { toast } from '../ui/feedback.js';

const TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';

export function initOrganize() {
  $('#btnSelectAll').onclick = () => setSelection(state.pages.map((p) => p.uid));
  $('#btnSelectNone').onclick = () => setSelection([]);

  $('#btnRotL').onclick = () => rotatePages(targetPages(), -90);
  $('#btnRotR').onclick = () => rotatePages(targetPages(), 90);
  $('#btnDuplicate').onclick = () => duplicatePages(targetPages());
  $('#btnDelete').onclick = () => {
    const doomed = targetPages();
    if (doomed.length === state.pages.length) {
      toast('That would delete every page. Keep at least one.', 'err');
      return;
    }
    deletePages(doomed);
  };
  $('#btnMoveFront').onclick = () => moveToEnd(targetPages(), 'front');
  $('#btnMoveBack').onclick = () => moveToEnd(targetPages(), 'back');
  $('#btnReverse').onclick = () => reversePages();

  const zoom = $('#zoom');
  zoom.addEventListener('input', () => setThumbScale(Number(zoom.value)));
  setThumbScale(Number(zoom.value));

  on('sources', renderFileList);
  on('pages', renderFileList);
  renderFileList();
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
  if (!state.sources.size) return;

  host.append(el('div', { class: 'lbl', text: `Open files (${state.sources.size})` }));
  for (const src of state.sources.values()) {
    const used = state.pages.filter((p) => p.srcId === src.id).length;
    host.append(el('div', { class: 'row' },
      el('div', { class: 'grow' },
        el('div', { text: src.name, title: src.name }),
        el('div', { class: 'sub', text: `${describeUse(used, src.pageCount)} · ${fmtBytes(src.size)}` })),
      el('button', {
        title: 'Remove this file’s pages',
        html: TRASH,
        onclick: () => {
          const mine = state.pages.filter((p) => p.srcId === src.id);
          if (mine.length === state.pages.length) {
            toast('That would empty the document. Use Clear instead.', 'err');
            return;
          }
          dropPages(mine);
        },
      })));
  }
}
