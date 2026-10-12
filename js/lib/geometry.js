// Stamp geometry, kept free of the DOM and of pdf-lib so it can be reasoned
// about (and tested) on its own.
//
// A PDF page has an unrotated box W × H plus a /Rotate entry that viewers apply
// clockwise at display time. Users place stamps on what they see, so stamps are
// stored in "display space": origin at the bottom-left of the *rotated* page,
// y pointing up, coordinates as fractions of the rotated page's width/height.

export const norm = (deg) => ((Math.round(deg) % 360) + 360) % 360;

/** A typed stamp angle folded into (-180, 180]: -200 becomes 160. Decimals survive. */
export function normalizeAngle(deg) {
  const r = ((deg % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

/** Size of the page as displayed, given its unrotated box. */
export const visualSize = (w, h, rot) => (norm(rot) % 180 === 0 ? { vw: w, vh: h } : { vw: h, vh: w });

/** Display-space point (y-up) -> the page's own unrotated coordinates. */
export function toPageSpace(vx, vy, W, H, rot) {
  switch (norm(rot)) {
    case 90:  return { x: W - vy, y: vx };
    case 180: return { x: W - vx, y: H - vy };
    case 270: return { x: vy, y: H - vx };
    default:  return { x: vx, y: vy };
  }
}

/** The inverse of {@link toPageSpace}, used by the tests to prove the round trip. */
export function toDisplaySpace(x, y, W, H, rot) {
  switch (norm(rot)) {
    case 90:  return { vx: y, vy: W - x };
    case 180: return { vx: W - x, vy: H - y };
    case 270: return { vx: H - y, vy: x };
    default:  return { vx: x, vy: y };
  }
}

/**
 * Works out where pdf-lib should anchor a stamp.
 *
 * pdf-lib draws from the lower-left corner and rotates about that same corner,
 * but a stamp is positioned by its center, so shift back by half the stamp's
 * size along its own rotated axes. The draw angle also has to absorb the page
 * rotation: a stamp drawn at angle `a` on a page rotated `rot` clockwise appears
 * at `a - rot`, so we add `rot` to land on the angle the user chose.
 *
 * @returns {{x:number, y:number, angle:number}} in unrotated page coordinates
 */
export function anchorStamp({ u, v, rot: stampRot }, { W, H, rot }, width, height) {
  const { vw, vh } = visualSize(W, H, rot);
  const angle = stampRot + norm(rot);
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const center = toPageSpace(u * vw, v * vh, W, H, rot);
  return {
    x: center.x + (-width / 2) * cos - (-height / 2) * sin,
    y: center.y + (-width / 2) * sin + (-height / 2) * cos,
    angle,
  };
}

/** Center of a stamp in display space, back from a pdf-lib anchor. Test helper. */
export function centerFromAnchor({ x, y, angle }, width, height) {
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: x - ((-width / 2) * cos - (-height / 2) * sin),
    y: y - ((-width / 2) * sin + (-height / 2) * cos),
  };
}
