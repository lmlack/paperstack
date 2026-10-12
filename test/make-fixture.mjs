// Builds test/fixture.pdf: four pages of known text, one of them pre-rotated,
// plus an embedded PNG so the image extractor has something real to find.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, degrees, rgb } from '../vendor/pdf-lib.esm.min.js';

/** Minimal RGB PNG encoder, enough for a test fixture. */
function png(width, height, pixel) {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;                       // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;             // 8-bit, truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? -306674912 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const LABELS = ['PAGEONE', 'PAGETWO', 'PAGETHREE', 'PAGEFOUR'];

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.HelveticaBold);
const stripes = await doc.embedPng(png(64, 64, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? [20, 90, 220] : [250, 240, 30])));

LABELS.forEach((label, i) => {
  const page = doc.addPage(i === 1 ? [400, 650] : [612, 792]);
  page.drawText(label, { x: 60, y: page.getHeight() - 140, size: 34, font, color: rgb(0.08, 0.1, 0.16) });
  page.drawText(`body text for page ${i + 1}`, { x: 60, y: page.getHeight() - 190, size: 13, font, color: rgb(0.35, 0.38, 0.45) });
  if (i === 0) page.drawImage(stripes, { x: 60, y: 120, width: 180, height: 180 });
  if (i === 2) page.setRotation(degrees(90));   // a page that is already turned
});

writeFileSync(join(import.meta.dirname, 'fixture.pdf'), await doc.save());
console.log('fixture.pdf written:', LABELS.length, 'pages');
