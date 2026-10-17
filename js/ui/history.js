// Undo and redo for the whole app: the buttons in the page grid and the
// editor, the keyboard shortcuts, and the toasts that say what was undone.

import { $$ } from '../lib/dom.js';
import { on, undo, redo, canUndo, canRedo } from '../state.js';
import { toast } from './feedback.js';

export function doUndo() {
  const label = undo();
  if (label) toast(`Undone: ${label}`, '', 3500, { label: 'Redo', run: doRedo }, 'history');
  else toast('Nothing to undo.', '', 2000, null, 'history');
}

export function doRedo() {
  const label = redo();
  if (label) toast(`Redone: ${label}`, '', 3500, { label: 'Undo', run: doUndo }, 'history');
  else toast('Nothing to redo.', '', 2000, null, 'history');
}

/** Confirms a change that is easy to regret, with an Undo button on the toast. */
export function undoable(message) {
  toast(message, 'ok', 6500, { label: 'Undo', run: doUndo }, 'history');
}

/** True for Cmd/Ctrl+Z (undo) or Cmd/Ctrl+Shift+Z and Ctrl+Y (redo); runs it. */
export function historyKey(e) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) doUndo();
  else if ((key === 'z' && e.shiftKey) || key === 'y') doRedo();
  else return false;
  e.preventDefault();
  return true;
}

export function initHistory() {
  const sync = () => {
    for (const b of $$('[data-history="undo"]')) b.disabled = !canUndo();
    for (const b of $$('[data-history="redo"]')) b.disabled = !canRedo();
  };
  for (const b of $$('[data-history="undo"]')) b.onclick = doUndo;
  for (const b of $$('[data-history="redo"]')) b.onclick = doRedo;
  on('history', sync);
  sync();
}
