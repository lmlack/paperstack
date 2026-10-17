// Toasts and the blocking progress overlay.

import { $, el } from '../lib/dom.js';

const host = $('#toasts');
const overlay = $('#busy');
const label = $('#busyLabel');
const bar = $('#busyBar');

/**
 * A short message at the bottom of the screen. With `action` ({ label, run })
 * it carries a button, e.g. Undo, and stays a little longer to give time to
 * reach it. Toasts with the same `key` replace each other rather than stack.
 */
export function toast(message, kind = '', ms = 4200, action = null, key = null) {
  if (key) host.querySelector(`[data-key="${key}"]`)?.remove();
  const node = el('div', { class: `toast ${kind}`.trim(), role: kind === 'err' ? 'alert' : 'status' },
    el('span', { text: message }));
  if (key) node.dataset.key = key;
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 300);
  };
  if (action) {
    node.append(el('button', { class: 'toast-act', text: action.label,
      onclick: () => { dismiss(); action.run(); } }));
    ms = Math.max(ms, 6500);
  }
  // Older toasts make way, so a burst of them never covers the page.
  while (host.children.length >= 3) host.firstElementChild.remove();
  host.append(node);
  timer = setTimeout(dismiss, ms);
}

let depth = 0;

/** Shows the overlay; returns a handle you must close in a `finally`. */
export function busy(text = 'Working…') {
  depth++;
  label.textContent = text;
  bar.style.width = '0%';
  overlay.hidden = false;
  return {
    label(next) { label.textContent = next; },
    step(done, total) {
      bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    },
    close() {
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.hidden = true;
    },
  };
}

/** Runs `job` behind the overlay, reporting failures as a toast. */
export async function withBusy(text, job) {
  const ui = busy(text);
  try {
    return await job(ui);
  } catch (err) {
    console.error(err);
    toast(err?.message || 'Something went wrong.', 'err', 6500);
    return undefined;
  } finally {
    ui.close();
  }
}
