// Turns the workspace (page order + rotations + stamps) into PDF bytes.
//
// Coordinate note: a PDF page has an unrotated box (W × H) plus a /Rotate entry
// that viewers apply clockwise at display time. Users place watermarks on what
// they *see*, so stamps are stored in "display space" (origin bottom-left of the
// rotated page, fractions of its width/height) and mapped back here.

import { PDFDocument, StandardFonts, degrees, rgb } from '../vendor/pdf-lib.esm.min.js';
import { state, srcOf } from './state.js';
import { hexToRgb01 } from './lib/dom.js';
import { norm, visualSize, anchorStamp } from './lib/geometry.js';

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
      const { width: W, height: H } = page.getSize();
      for (const stamp of record.stamps) {
        await drawStamp(page, stamp, { W, H, rot }, { font, image });
      }
    }
    onProgress?.(i + 1, pages.length);
  }

  return out.save({ useObjectStreams: true });
}

async function drawStamp(page, stamp, box, resolve) {
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
