// Turns the workspace (page order + rotations + stamps) into PDF bytes.
//
// Coordinate note: a PDF page has an unrotated box (W × H) plus a /Rotate entry
// that viewers apply clockwise at display time. Users place watermarks on what
// they *see*, so stamps are stored in "display space" (origin bottom-left of the
// rotated page, fractions of its width/height) and mapped back here.

import {
  PDFDocument, PDFHexString, PDFString, StandardFonts, degrees, rgb,
  LineCapStyle, LineJoinStyle, pushGraphicsState, popGraphicsState, setLineWidth,
  setLineCap, setLineJoin, setStrokingRgbColor, moveTo, lineTo, stroke,
} from '../vendor/pdf-lib.esm.min.js';
import { state, srcOf } from './state.js';
import { hexToRgb01 } from './lib/dom.js';
import { norm, visualSize, anchorStamp, toPageSpace } from './lib/geometry.js';
import { NOTE, noteBox } from './lib/textwrap.js';

const FONTS = {
  Helvetica: StandardFonts.Helvetica,
  HelveticaBold: StandardFonts.HelveticaBold,
  TimesRoman: StandardFonts.TimesRoman,
  TimesRomanItalic: StandardFonts.TimesRomanItalic,
  Courier: StandardFonts.Courier,
};

/**
 * Builds one PDF from a list of workspace pages.
 * @param {object[]} pages workspace page records, in output order
 * @param {(done:number,total:number)=>void} [onProgress]
 */
export async function assemble(pages, onProgress) {
  if (!pages.length) throw new Error('There are no pages to write.');

  const out = await PDFDocument.create();
  out.setProducer('Paperstack');
  out.setCreator('Paperstack (in-browser PDF editor)');

  const loaded = new Map();   // srcId -> PDFDocument
  const fonts = new Map();    // font key -> embedded font
  const images = new Map();   // assetId -> embedded image

  const sourceDoc = async (srcId) => {
    if (!loaded.has(srcId)) {
      const src = state.sources.get(srcId);
      loaded.set(srcId, await PDFDocument.load(src.bytes, { ignoreEncryption: true }));
    }
    return loaded.get(srcId);
  };

  const font = async (key) => {
    if (!fonts.has(key)) fonts.set(key, await out.embedFont(FONTS[key] ?? StandardFonts.Helvetica));
    return fonts.get(key);
  };

  const image = async (assetId) => {
    if (!images.has(assetId)) {
      const asset = state.assets.get(assetId);
      if (!asset) return null;
      images.set(assetId, asset.mime === 'image/png'
        ? await out.embedPng(asset.bytes)
        : await out.embedJpg(asset.bytes));
    }
    return images.get(assetId);
  };

  for (let i = 0; i < pages.length; i++) {
    const record = pages[i];
    const doc = await sourceDoc(record.srcId);
    const [copied] = await out.copyPages(doc, [record.index]);
    const page = out.addPage(copied);

    const base = page.getRotation().angle;
    const rot = norm(base + record.rot);
    page.setRotation(degrees(rot));

    if (record.stamps.length) {
      const box = { ...visibleBox(page), rot };
      for (const stamp of record.stamps) {
        if (stamp.type === 'comment') addComment(out, page, stamp, box);
        else await drawStamp(page, stamp, box, { font, image });
      }
    }
    onProgress?.(i + 1, pages.length);
  }

  return out.save({ useObjectStreams: true });
}

/**
 * The part of the page a viewer shows, which is what stamps are placed on: the
 * CropBox clipped to the MediaBox, as PDF.js draws it. Its corner is often not
 * (0, 0), and ignoring that shifted every stamp left and down on export.
 */
export function visibleBox(page) {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const x0 = Math.max(media.x, crop.x);
  const y0 = Math.max(media.y, crop.y);
  const x1 = Math.min(media.x + media.width, crop.x + crop.width);
  const y1 = Math.min(media.y + media.height, crop.y + crop.height);
  // A broken CropBox that misses the MediaBox: viewers fall back to the MediaBox.
  if (x1 <= x0 || y1 <= y0) return { x0: media.x, y0: media.y, W: media.width, H: media.height };
  return { x0, y0, W: x1 - x0, H: y1 - y0 };
}

async function drawStamp(page, stamp, box, resolve) {
  if (stamp.type === 'note') {
    await drawNote(page, stamp, box, await resolve.font(stamp.font));
    return;
  }
  if (stamp.type === 'ink') {
    drawInk(page, stamp, box);
    return;
  }
  if (stamp.type === 'text') {
    const font = await resolve.font(stamp.font);
    const width = font.widthOfTextAtSize(stamp.text, stamp.size);
    const height = font.heightAtSize(stamp.size, { descender: false });
    const { x, y, angle } = anchorStamp(stamp, box, width, height);
    const { r, g, b } = hexToRgb01(stamp.color);
    page.drawText(stamp.text, {
      x, y,
      size: stamp.size,
      font,
      color: rgb(r, g, b),
      opacity: stamp.opacity,
      rotate: degrees(angle),
    });
    return;
  }

  const img = await resolve.image(stamp.assetId);
  if (!img) return;
  const { vw } = visualSize(box.W, box.H, box.rot);
  const width = stamp.w * vw;
  const height = width * (img.height / img.width);
  const { x, y, angle } = anchorStamp(stamp, box, width, height);
  page.drawImage(img, {
    x, y, width, height,
    opacity: stamp.opacity,
    rotate: degrees(angle),
  });
}

/**
 * A note written onto the page: an optional card, then each stored line, left
 * aligned. Every piece is placed by its own center in display space, so the
 * page's /Rotate is absorbed by anchorStamp exactly as it is for watermarks.
 */
async function drawNote(page, stamp, box, font) {
  const { vw, vh } = visualSize(box.W, box.H, box.rot);
  const { size, lines } = stamp;
  const outer = noteBox(lines, size, stamp.w * vw);

  if (stamp.bg) {
    const { x, y, angle } = anchorStamp({ u: stamp.u, v: stamp.v, rot: 0 }, box, outer.width, outer.height);
    const { r, g, b } = hexToRgb01(stamp.bg);
    page.drawRectangle({ x, y, width: outer.width, height: outer.height, rotate: degrees(angle), color: rgb(r, g, b) });
  }

  const { r, g, b } = hexToRgb01(stamp.color);
  const left = stamp.u * vw - outer.width / 2 + size * NOTE.pad;
  const top = stamp.v * vh + outer.height / 2 - size * NOTE.pad;
  const ascent = font.heightAtSize(size, { descender: false });
  lines.forEach((line, i) => {
    if (!line) return;
    const width = font.widthOfTextAtSize(line, size);
    const centerY = top - (i + 0.5) * size * NOTE.line;
    const { x, y, angle } = anchorStamp({ u: (left + width / 2) / vw, v: centerY / vh, rot: 0 }, box, width, ascent);
    page.drawText(line, { x, y, size, font, color: rgb(r, g, b), rotate: degrees(angle) });
  });
}

/**
 * A freehand line drawn in the viewer, written as a vector path so it stays
 * sharp at any zoom. Its points are display-space fractions like every other
 * stamp, mapped one by one into the page's own coordinates.
 */
function drawInk(page, stamp, box) {
  const { vw, vh } = visualSize(box.W, box.H, box.rot);
  const pts = stamp.points.map(([u, v]) => {
    const p = toPageSpace(u * vw, v * vh, box.W, box.H, box.rot);
    return [p.x + (box.x0 ?? 0), p.y + (box.y0 ?? 0)];
  });
  // A tap is a single point; a zero-length round-capped line draws it as a dot.
  if (pts.length === 1) pts.push(pts[0]);
  const { r, g, b } = hexToRgb01(stamp.color);
  page.pushOperators(
    pushGraphicsState(),
    setStrokingRgbColor(r, g, b),
    setLineWidth(stamp.width),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
    moveTo(...pts[0]),
    ...pts.slice(1).map((p) => lineTo(...p)),
    stroke(),
    popGraphicsState(),
  );
}

const COMMENT_PT = 20;   // the icon's box; viewers draw their own icon in it

/**
 * A sticky-note comment: a real /Text annotation, so Preview and Acrobat show
 * it as a note icon that opens, can be edited, and does not print. Exported so
 * the rasterizing compressor can carry comments over to its redrawn pages.
 */
export function addComment(doc, page, stamp, box) {
  const { vw, vh } = visualSize(box.W, box.H, box.rot);
  const cx = stamp.u * vw;
  const cy = stamp.v * vh;
  const half = COMMENT_PT / 2;
  const corners = [[cx - half, cy - half], [cx + half, cy + half]]
    .map(([x, y]) => toPageSpace(x, y, box.W, box.H, box.rot));
  const xs = corners.map((c) => c.x + (box.x0 ?? 0));
  const ys = corners.map((c) => c.y + (box.y0 ?? 0));
  const { r, g, b } = hexToRgb01(stamp.color);

  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    Contents: PDFHexString.fromText(stamp.text),
    Name: 'Comment',
    C: [r, g, b],
    F: 24,                 // NoZoom | NoRotate, and no Print flag
    Open: false,
    M: PDFString.fromDate(new Date(stamp.created ?? Date.now())),
  });
  page.node.addAnnot(doc.context.register(annot));
}

/**
 * Text metrics for laying out notes before export, from the same standard
 * fonts the export embeds. `clean` swaps characters the font cannot encode
 * (emoji, most non-Latin scripts) for "?", which pdf-lib would otherwise
 * refuse at export time.
 */
const metricFonts = new Map();
let metricDoc;
export async function noteMetrics(key) {
  if (!metricFonts.has(key)) {
    metricDoc ??= await PDFDocument.create();
    const font = await metricDoc.embedFont(FONTS[key] ?? StandardFonts.Helvetica);
    const charset = new Set(font.getCharacterSet());
    metricFonts.set(key, {
      measure: (text, size) => font.widthOfTextAtSize(text, size),
      clean: (text) => [...text].map((ch) => (ch === '\n' || charset.has(ch.codePointAt(0)) ? ch : '?')).join(''),
    });
  }
  return metricFonts.get(key);
}

/**
 * A page as the user sees it: size in points plus the total rotation to hand to
 * PDF.js. Used by the signature placement stage.
 */
export async function displayInfo(record) {
  const src = srcOf(record);
  const page = await src.pdfjs.getPage(record.index + 1);
  const rotation = norm(page.rotate + record.rot);
  const view = page.getViewport({ scale: 1, rotation });
  page.cleanup();
  return { w: view.width, h: view.height, rotation };
}
