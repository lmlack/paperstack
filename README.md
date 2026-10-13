# Paperstack

A PDF editor that runs entirely in your browser. Files are read with JavaScript
in the tab you have open. Nothing is uploaded, and there is no server to upload
anything to. Open the network tab and watch it stay empty.

No build step, no bundler, no `npm install`. The libraries and fonts are
vendored in `vendor/`, so the app also works with the network switched off.

```sh
node serve.js            # http://localhost:8080
```

Any static server works (`python3 -m http.server`, `npx serve`, nginx, GitHub
Pages). A plain `file://` open will *not* work, because browsers refuse to load
ES modules from the filesystem. That is the only reason `serve.js` exists.

It lives at `paperstack.gwark.dev` and links back from the top bar, which
carries gwark.dev's own mark and returns you to the `#projects` rack it was
launched from. The empty state links home too.

The mark is inlined in `index.html` rather than loaded as a file, so it takes
the link's color in both themes. It is traced from gwark.dev's master logo
artwork: the 12-tooth gear, the globe with its line and node, and the orbit
whose front half crosses over both, drawn with masks so the crossings stay
correct on any background.

Both URLs live in `index.html` and in the `OUTBOUND_ALLOWED` list in
`test/wiring.test.mjs`. A link to anywhere else fails that test.

## What it does

Click the magnifier on any page, or just double-click it, to open the
**full-size viewer**: one page at a time, zoomable, with the watermarks and
signatures you have queued drawn on top, so you see what you are about to
export. Arrow keys page through it, `+` and `-` zoom, `0` fits, `[` and `]`
rotate, `Esc` closes.

| Tool | |
|---|---|
| **Organize** | Merge several PDFs, drag pages into any order, rotate, duplicate, delete, reverse. Drop images in to add them as pages. |
| **Compress** | Structural rewrite that keeps text selectable, or redraw every page as a JPEG at a chosen resolution for scans. |
| **Watermark** | Text or image, at any angle (drag the slider or type an exact value), opacity, color and placement. Single or tiled, on all pages, a selection, or a range. |
| **Sign** | Draw with a mouse or finger, type one in a script face, or upload a photo of your signature (white paper is keyed out automatically). Drag it into place on a full-size page. |
| **Notes** | Write a note onto any page, on a yellow or white card or bare, and drag it into place; it prints and shows in every app. Or leave a sticky note: a real PDF comment that opens when clicked in Preview or Acrobat, stays editable there, and does not print. |
| **Extract** | Pull out the text layer, or find and save embedded images. |
| **Split** | Selected pages, custom ranges, every N pages, or one file per page. Several files come back as a zip. |

**Share** sits next to Export and opens your device's share sheet, so the
edited PDF can go out by AirDrop, Mail, Messages or anything else installed.
The file goes from the tab to the operating system, not to a server. The
button only appears in browsers that can share files (Safari, Chrome and Edge
on macOS, iOS, Android and Windows; not Firefox on desktop).

**Start over** in the top bar closes every open file and returns you to the
drop zone. It confirms first, and the prompt says how many pages and marks you
are about to lose.

Shortcuts: `Cmd/Ctrl+A` select all, `Cmd/Ctrl+S` export, `[` and `]` rotate,
`Delete` remove, `Esc` clear selection. The viewer has its own set, listed
along the bottom of its window.

## How it looks

The two themes are lifted from the two sites this was styled after.

**Light** is startipsum.org: warm paper (`#fff8ec`), near-black ink, teal for
anything interactive, near-black pills for primary actions, and a yellow
highlight pill borrowed from its "Newly Added" filter.

**Dark** is hamsterdome.com: deep space (`#070318`), lavender text, cyan
accents, a violet primary button that glows a little, and a quiet tiled star
field behind the page grid, the drop zone and the viewer.

Both run on Atkinson Hyperlegible, with its mono cut for anything numeric
(page numbers, byte counts, zoom levels, the stats counter) and Righteous for
the wordmark. All three are vendored, so no font CDN ever learns that you
opened the app.

## How it is put together

```
index.html            all the markup; the JS only wires it up
css/app.css           one stylesheet, CSS custom properties, two themes
js/
  main.js             file intake, dock, export, theme, shortcuts
  state.js            the workspace: sources, page order, stamps, selection
  assemble.js         workspace to PDF bytes, via pdf-lib
  pdfjs.js            PDF.js setup, thumbnail cache, render queue
  lib/geometry.js     stamp placement math (no DOM, no pdf-lib, unit tested)
  lib/zip.js          a "stored" zip writer, about 90 lines
  lib/dom.js          small helpers
  ui/pagegrid.js      thumbnails, selection, drag-to-reorder
  ui/viewer.js        the full-size page viewer
  ui/stamps.js        draws queued marks over a page (grid and viewer share it)
  ui/feedback.js      toasts and the progress overlay
  tools/*.js          one module per panel
vendor/               pdf-lib 1.17.1 (MIT), PDF.js 6.2.108 (Apache-2.0),
                      Atkinson Hyperlegible and Righteous (SIL Open Font License)
```

Two ideas carry most of the design.

**Every page is "a page of some source PDF."** The workspace is an ordered list
of `{ srcId, index, rot, stamps }`. Merging appends, splitting slices,
reordering shuffles, and an imported image becomes a one-page PDF on the way
in, so it needs no special case anywhere downstream.

**Stamps are stored in display space.** A PDF page has an unrotated box plus a
`/Rotate` entry that viewers apply clockwise. You place a watermark on what you
*see*, so stamps are kept as fractions of the rotated page and mapped back at
export time, in `lib/geometry.js`. That is why "bottom right" stays bottom
right on a page that is turned 90 degrees, and why nothing is burned in until
you export: a watermark can be removed right up to the last moment.

Marks preview the same way everywhere. A stamp's size is stored in points, and
both the thumbnail and the viewer render it in container-query units, so a
48 pt mark on a 612 pt page is 7.8% of that page's width whether the page is
drawn 180 px wide or 1800. One implementation, correct at every scale.

## Tests

```sh
npm test            # everything below, in order
```

- `node --test test/` covers stamp geometry (round trips at every rotation),
  page-range parsing, and the zip writer, verified by running the system
  `unzip -t` over its output. Plus static wiring: every `#id` the JS reaches
  for exists in the markup, every import resolves, **nothing is fetched from a
  remote URL**, and the only links that leave the page are the ones to
  gwark.dev. The privacy claim is enforced by a test, and a link you can click
  is held to a different standard than a request the page makes on its own.
- `test/run-browser.mjs` drives real headless Chrome over CDP. One phase works
  the modules and re-parses the PDFs they produce; the other clicks through
  `index.html` like a user. Watermark placement is checked by **sampling
  pixels** in the rendered output, so the rotation math is proven, not assumed.
- `test/artifact.mjs` performs a full edit, writes the PDF to disk, and checks
  it with parsers that are not ours: Spotlight's PDF importer and Quick Look's
  CoreGraphics renderer.
- `node test/shots.mjs <dir>` writes screenshots of the app in ten states.

## Limits worth knowing

- **Password-protected PDFs are refused.** pdf-lib cannot decrypt them, so the
  app says so plainly rather than half working.
- **"Shrink hard" destroys the text layer.** Each page becomes a JPEG. The
  panel warns about this. It is the right tool for scans and the wrong one for
  reports.
- **"Optimize" will not always help.** On a file that is already lean it hands
  back the original rather than a larger rewrite.
- **Scanned pages have no text to extract.** There is no OCR here, so the app
  tells you when it finds nothing instead of handing back an empty file.
- Everything happens in the tab, so a 500-page scan will use real memory and a
  real amount of your CPU.

## License

Two licenses, because the code and the writing are different kinds of work.

- **Code** (`js/`, `css/`, `test/`, `serve.js`, and the page itself) is MIT.
  See `LICENSE`.
- **Writing** (this README, including the limits above) is Creative Commons
  Attribution 4.0. See `LICENSE-CC-BY-4.0`.

Attribution that satisfies CC BY:

```
Paperstack by lmlack, CC BY 4.0, https://paperstack.gwark.dev/
```

The gwark mark, inlined in the header of `index.html`, is brand identity, not
content, and is reserved rather than licensed.

Vendored libraries and fonts keep their own licenses: pdf-lib (MIT), PDF.js
(Apache-2.0), Atkinson Hyperlegible and Righteous (SIL Open Font License). See
`THIRD-PARTY.md`.
