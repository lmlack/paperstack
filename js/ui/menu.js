// A small popup anchored to a button: a list of choices, or a little form.
// One is open at a time; a click elsewhere or Esc closes it.

import { el } from '../lib/dom.js';

let open = null;   // { node, anchor }

export function closeMenu() {
  if (!open) return;
  const { node, anchor } = open;
  open = null;
  node.remove();
  anchor.setAttribute('aria-expanded', 'false');
}

/**
 * Opens a popup under `anchor`. `items` are { label, icon?, hint?, run }, or
 * DOM nodes for anything else (a heading, a small form).
 */
export function openMenu(anchor, items, { label = '' } = {}) {
  const again = open?.anchor === anchor;
  closeMenu();
  if (again) return null;   // a second press on the same button closes it

  const node = el('div', { class: 'popmenu', role: 'menu', 'aria-label': label });
  for (const item of items) {
    if (item instanceof Node) { node.append(item); continue; }
    node.append(el('button', {
      role: 'menuitem',
      class: 'popmenu-item',
      onclick: () => { closeMenu(); item.run(); },
    },
    item.icon ? el('span', { class: 'popmenu-ico', html: item.icon }) : null,
    el('span', { class: 'popmenu-text' },
      el('span', { text: item.label }),
      item.hint ? el('span', { class: 'popmenu-hint', text: item.hint }) : null)));
  }
  document.body.append(node);
  anchor.setAttribute('aria-expanded', 'true');
  open = { node, anchor };

  // Under the button, kept on screen.
  const a = anchor.getBoundingClientRect();
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, a.left + a.width / 2 - w / 2));
  const below = a.bottom + 6;
  const top = below + h > window.innerHeight - 8 ? Math.max(8, a.top - h - 6) : below;
  Object.assign(node.style, { left: `${left}px`, top: `${top}px` });
  (node.querySelector('input, button'))?.focus();
  return node;
}

document.addEventListener('pointerdown', (e) => {
  if (open && !open.node.contains(e.target) && !open.anchor.contains(e.target)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (open && e.key === 'Escape') {
    e.stopPropagation();
    const { anchor } = open;
    closeMenu();
    anchor.focus();
  }
}, true);
window.addEventListener('resize', closeMenu);
