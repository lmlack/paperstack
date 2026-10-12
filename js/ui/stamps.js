// Draws an approximation of a page's stamps over a rendered page, used by both
// the thumbnail grid and the full-size viewer.
//
// Sizes are given in container-query units so one implementation works at any
// scale: a 48 pt mark on a 612 pt page is 7.8% of the page's width, whether
// that page is drawn 180 px wide or 1800.

import { $, el } from '../lib/dom.js';
import { state } from '../state.js';

const FAMILY = {
  TimesRoman: 'Times, "Times New Roman", serif',
  TimesRomanItalic: 'Times, "Times New Roman", serif',
  Courier: 'ui-monospace, Menlo, monospace',
};

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
    const node = el('div', { class: 'st' });
    node.style.left = `${stamp.u * 100}%`;
    node.style.top = `${(1 - stamp.v) * 100}%`;
    node.style.opacity = stamp.opacity;
    // CSS rotates clockwise, PDFs counter-clockwise.
    node.style.transform = `translate(-50%, -50%) rotate(${-stamp.rot}deg)`;

    if (stamp.type === 'text') {
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

/** Convenience for a tile or sheet that holds a `.stamps` layer. */
export function paintStampsIn(host, page, pageWidthPt) {
  const layer = $('.stamps', host);
  if (layer) paintStamps(layer, page, pageWidthPt);
}
