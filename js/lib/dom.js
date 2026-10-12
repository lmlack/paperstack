// Tiny DOM + formatting helpers. No framework.

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid != null) node.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return node;
}

let seq = 0;
export const uid = (prefix = 'id') => `${prefix}${++seq}`;

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Wire a `.seg` / `.posgrid` group of buttons; calls back with the chosen data-v. */
export function segment(root, onPick) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]');
    if (!btn || btn.classList.contains('active')) return;
    $$('button', root).forEach((b) => b.classList.toggle('active', b === btn));
    onPick(btn.dataset.v, btn);
  });
  return {
    get value() { return ($('button.active', root) || {}).dataset?.v; },
    set value(v) {
      $$('button', root).forEach((b) => b.classList.toggle('active', b.dataset.v === v));
    },
  };
}

/** Mirror a range input into its <output>, formatted. */
export function bindRange(input, output, format = (v) => v) {
  const sync = () => { output.value = format(Number(input.value)); };
  input.addEventListener('input', sync);
  sync();
  return sync;
}

/** Let the browser paint, so spinners and progress bars actually move. */
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** "1-3, 7, 10-12" becomes [0,1,2,6,9,10,11]: zero-based, clamped, deduped, ordered. */
export function parseRanges(spec, max) {
  const out = new Set();
  for (const chunk of String(spec).split(',')) {
    const part = chunk.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)\s*(?:[-–]\s*(\d+))?$/);
    if (!m) throw new Error(`Cannot read "${part}". Use formats like 3 or 5-9.`);
    let a = Number(m[1]);
    let b = m[2] === undefined ? a : Number(m[2]);
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > max) throw new Error(`Page ${b > max ? b : a} is outside this document (1–${max}).`);
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  if (!out.size) throw new Error('No pages selected.');
  return [...out].sort((x, y) => x - y);
}

/** Same, but keeps each range as its own group: "1-3, 7" becomes [[0,1,2],[6]] */
export function parseRangeGroups(spec, max) {
  const groups = [];
  for (const chunk of String(spec).split(',')) {
    const part = chunk.trim();
    if (!part) continue;
    groups.push(parseRanges(part, max));
  }
  if (!groups.length) throw new Error('No ranges given.');
  return groups;
}

export const hexToRgb01 = (hex) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
};

export const safeName = (s) => (s || 'document').replace(/\.pdf$/i, '').replace(/[^\w\-. ]+/g, '_').slice(0, 80);
