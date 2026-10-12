// Toasts and the blocking progress overlay.

import { $, el } from '../lib/dom.js';

const host = $('#toasts');
const overlay = $('#busy');
const label = $('#busyLabel');
const bar = $('#busyBar');

export function toast(message, kind = '', ms = 4200) {
  const node = el('div', { class: `toast ${kind}`.trim(), text: message });
  host.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 300);
  }, ms);
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
