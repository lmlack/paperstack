// Draws an approximation of a page's stamps over a rendered page, used by both
// the thumbnail grid and the full-size viewer.
//
// Sizes are given in container-query units so one implementation works at any
// scale: a 48 pt mark on a 612 pt page is 7.8% of the page's width, whether
// that page is drawn 180 px wide or 1800.

import { $, el } from '../lib/dom.js';
import { state } from '../state.js';
import { NOTE } from '../lib/textwrap.js';

const FAMILY = {
  TimesRoman: 'Times, "Times New Roman", serif',
  TimesRomanItalic: 'Times, "Times New Roman", serif',
  Courier: 'ui-monospace, Menlo, monospace',
};

// Arial and Courier New share Helvetica's and Courier's glyph widths, so a note
// wrapped with the PDF's own metrics breaks in the same places here.
const NOTE_FAMILY = {
  TimesRoman: 'Times, "Times New Roman", serif',
  Courier: '"Courier New", Courier, monospace',
};

const COMMENT_PT = 20;
const COMMENT_ICON = '<svg viewBox="0 0 24 24"><path d="M5 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-7l-5 4v-4H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M8 8.5h8M8 12h5"/></svg>';

/**
 * @param {HTMLElement} layer  an element with `position: absolute; inset: 0`
 * @param {object} page        a workspace page record
 * @param {number} pageWidthPt the page's displayed width in points
 */
export function paintStamps(layer, page, pageWidthPt) {
  layer.textContent = '';
  if (!page?.stamps.length) return;

  const widthPt = pageWidthPt || 612;
  for (const stamp of page.stamps) {
    if (stamp.type === 'ink') { layer.append(inkNode(stamp, widthPt)); continue; }
    const node = el('div', { class: 'st' });
    node.style.left = `${stamp.u * 100}%`;
    node.style.top = `${(1 - stamp.v) * 100}%`;
    node.style.opacity = stamp.opacity;
    // CSS rotates clockwise, PDFs counter-clockwise.
    node.style.transform = `translate(-50%, -50%) rotate(${-stamp.rot}deg)`;

    if (stamp.type === 'note') {
      const pt = (n) => `${(n / widthPt) * 100}cqw`;
      node.classList.add('note');
      node.textContent = stamp.lines.join('\n');
      Object.assign(node.style, {
        width: `${stamp.w * 100}%`,
        fontSize: pt(stamp.size),
        padding: pt(stamp.size * NOTE.pad),
        lineHeight: String(NOTE.line),
        color: stamp.color,
        background: stamp.bg ?? 'transparent',
        fontFamily: NOTE_FAMILY[stamp.font] ?? 'Helvetica, Arial, sans-serif',
        fontWeight: stamp.font === 'HelveticaBold' ? '700' : '400',
      });
    } else if (stamp.type === 'comment') {
      node.classList.add('comment');
      node.innerHTML = COMMENT_ICON;
      node.style.width = `${(COMMENT_PT / widthPt) * 100}cqw`;
      node.style.background = stamp.color;
    } else if (stamp.type === 'text') {
      node.textContent = stamp.text;
      node.style.color = stamp.color;
      node.style.fontSize = `${(stamp.size / widthPt) * 100}cqw`;
      node.style.fontFamily = FAMILY[stamp.font] ?? 'Helvetica, Arial, sans-serif';
      node.style.fontStyle = stamp.font.endsWith('Italic') ? 'italic' : 'normal';
    } else {
      const asset = state.assets.get(stamp.assetId);
      if (!asset) continue;
      node.style.width = `${stamp.w * 100}%`;
      node.append(el('img', { src: asset.url, alt: '' }));
    }
    layer.append(node);
  }
}

const SVG = 'http://www.w3.org/2000/svg';

/**
 * A drawn line, stretched over the whole page. The path is in page fractions,
 * so the SVG is squashed to the page's shape; non-scaling-stroke keeps the pen
 * round anyway, with its width in cqw like everything else here.
 */
export function inkNode(stamp, pageWidthPt) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'ink');
  svg.setAttribute('viewBox', '0 0 1 1');
  svg.setAttribute('preserveAspectRatio', 'none');
  const path = document.createElementNS(SVG, 'path');
  const pts = stamp.points.length === 1 ? [stamp.points[0], stamp.points[0]] : stamp.points;
  path.setAttribute('d', pts.map(([u, v], i) => `${i ? 'L' : 'M'}${u} ${1 - v}`).join(''));
  path.style.stroke = stamp.color;
  path.style.strokeWidth = `${(stamp.width / (pageWidthPt || 612)) * 100}cqw`;
  svg.append(path);
  return svg;
}

/** Convenience for a tile or sheet that holds a `.stamps` layer. */
export function paintStampsIn(host, page, pageWidthPt) {
  const layer = $('.stamps', host);
  if (layer) paintStamps(layer, page, pageWidthPt);
}
