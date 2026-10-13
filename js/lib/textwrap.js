// Note layout, kept free of the DOM and of pdf-lib. A note is wrapped once, when
// it is placed, and the resulting lines are stored on the stamp, so the
// thumbnail, the viewer and the exported PDF all break the text in the same
// places.

/** Proportions of a note box, as multiples of its font size. */
export const NOTE = {
  line: 1.25,   // line pitch
  pad: 0.45,    // inner padding on every side
};

/**
 * Greedy word wrap. Honors the line breaks the user typed, and breaks a word
 * that is wider than the line on its own by characters rather than letting it
 * spill out of the box.
 * @param {string} text
 * @param {number} maxWidth in the same units `measure` returns
 * @param {(s:string)=>number} measure width of a run of text
 * @returns {string[]}
 */
export function wrapText(text, maxWidth, measure) {
  const lines = [];
  for (const paragraph of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/ +/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) { line = candidate; continue; }
      if (line) lines.push(line);
      line = '';
      // A word too long for any line is cut at the last character that fits.
      let rest = word;
      while (measure(rest) > maxWidth && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && measure(rest.slice(0, cut)) > maxWidth) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  // Trailing blank lines only make the box taller.
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Outer size of a note box in points, padding included. */
export function noteBox(lines, size, widthPt) {
  return { width: widthPt, height: lines.length * size * NOTE.line + 2 * size * NOTE.pad };
}
