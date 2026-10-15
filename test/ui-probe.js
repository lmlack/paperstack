// Drives the real index.html through a browser: drops a file, clicks the tools,
// and checks what the user would actually see.

const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '' });
  } catch (err) {
    results.push({ name, ok: false, detail: `${err?.message}\n${err?.stack ?? ''}` });
  }
}

const assert = (cond, message) => { if (!cond) throw new Error(message); };
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Actually-on-screen, not merely "the hidden attribute is set". */
function visible(node) {
  if (!node) return false;
  if (getComputedStyle(node).display === 'none') return false;
  const box = node.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

/** Resolves once the viewer has finished drawing whatever it was asked for. */
async function settled() {
  await until(() => !$('#viewer').classList.contains('busy'), 'the viewer to settle');
  await sleep(40);
}

async function until(fn, what, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function probe() {
  const { state } = await import('/js/state.js');
  window.confirm = () => true;          // headless Chrome auto-dismisses dialogs

  await check('nothing is painted on top of the app at rest', () => {
    for (const sel of ['#placeModal', '#busy', '#workspace', '#dock', '#stats', '#btnExport', '#btnReset']) {
      assert(!visible($(sel)), `${sel} is on screen before anything is loaded`);
    }
    return 'no stray modals or overlays';
  });

  await check('offers a way back to gwark.dev', () => {
    const back = $('.backlink');
    assert(visible(back), 'no link home in the top bar');
    assert(back.getAttribute('href') === 'https://gwark.dev/#projects',
      `link points at ${back.getAttribute('href')}`);
    assert(/gwark\.dev/.test(back.textContent), `link reads "${back.textContent.trim()}"`);

    // gwark.dev's own mark, drawn in the link's color rather than a flat image
    const mark = back.querySelector('.gwark-mark');
    assert(mark, 'the gwark.dev mark is missing from the link');
    // Traced from the master logo: a 12-tooth gear outline (48 corners), and
    // masks for the orbit crossing over the gear and globe.
    const gear = [...mark.querySelectorAll('g path')].find((p) => (p.getAttribute('d').match(/L/g) || []).length === 47);
    assert(gear, 'the gear lost its teeth');
    assert(mark.querySelectorAll('mask').length === 3, 'the orbit crossings are missing');
    assert(mark.getAttribute('viewBox') === '0 0 100 100', 'the mark was redrawn by hand');
    const painted = getComputedStyle(mark.querySelector('g')).stroke;
    assert(painted === getComputedStyle(back).color,
      `the mark is painted ${painted} but the link is ${getComputedStyle(back).color}`);
    const box = mark.getBoundingClientRect();
    assert(box.width >= 16 && box.width <= 30, `the mark renders ${box.width}px wide`);

    const inDropzone = $('.dz-home a');
    assert(visible(inDropzone), 'no link home on the empty state');
    assert(inDropzone.getAttribute('href') === 'https://gwark.dev/', 'drop zone link points elsewhere');
    return 'top bar and drop zone';
  });

  await check('the explanatory text is big enough to read', () => {
    const px = (sel) => parseFloat(getComputedStyle($(sel)).fontSize);
    const floors = {
      '.dz-home': 16,
      '.hint': 15,           // the one-line explainer under each tool
      'body': 16,
    };
    for (const [sel, floor] of Object.entries(floors)) {
      assert($(sel), `${sel} is missing`);
      assert(px(sel) >= floor, `${sel} is ${px(sel)}px, under the ${floor}px floor`);
    }
    return `drop zone ${px('.dz-home')}px, hints ${px('.hint')}px, body ${px('body')}px`;
  });

  await check('starts on the drop zone with the tools hidden', () => {
    assert(visible($('#dropzone')), 'drop zone should be showing');
    assert(!visible($('#workspace')), 'workspace should be hidden');
    assert(!visible($('#dock')), 'tool dock should be hidden');
    assert(!visible($('#btnExport')), 'export button should be hidden');
    assert($$('.dock-tab').length === 7, `expected 7 tool tabs, found ${$$('.dock-tab').length}`);
    return '6 tools, nothing loaded';
  });

  await check('dropping a PDF fills the page grid', async () => {
    const bytes = await fetch('/test/fixture.pdf').then((r) => r.arrayBuffer());
    const file = new File([bytes], 'fixture.pdf', { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));

    await until(() => state.pages.length === 4, 'the file to open');
    assert(visible($('#workspace')), 'workspace did not appear');
    assert(visible($('#dock')), 'tool dock did not appear');
    assert(!visible($('#dropzone')), 'drop zone should be out of the way');
    assert($$('#pagegrid .tile').length === 4, `grid has ${$$('#pagegrid .tile').length} tiles`);
    assert($('#statPages').textContent === '4 pages', `stats read "${$('#statPages').textContent}"`);
    return $('#statPages').textContent + ', ' + $('#statSize').textContent;
  });

  await check('thumbnails appear on every tile', async () => {
    await until(() => $$('#pagegrid .tile canvas').length === 4, 'thumbnails to render');
    const sizes = $$('#pagegrid .tile canvas').map((c) => `${c.width}×${c.height}`);
    assert($$('#pagegrid .skel').length === 0, 'a loading shimmer is still showing');
    // Page 3 of the fixture is /Rotate 90, so its thumbnail must be landscape.
    const third = $$('#pagegrid .tile canvas')[2];
    assert(third.width > third.height, `rotated page rendered ${third.width}×${third.height}`);
    return sizes.join(', ');
  });

  await check('duplicating a page gives both copies their own thumbnail', async () => {
    const { duplicatePages } = await import('/js/state.js');
    duplicatePages([state.pages[0]]);
    await until(() => $$('#pagegrid .tile').length === 5, 'the duplicate tile');
    await until(() => $$('#pagegrid .tile canvas').length === 5, 'both thumbnails');

    // Both copies must carry real pixels. A shared canvas node would leave one blank.
    const inked = $$('#pagegrid .tile canvas').slice(0, 2).map((c) => {
      const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 200) dark++;
      return dark;
    });
    assert(inked[0] > 100 && inked[1] > 100, `page 1 and its copy rendered ${inked} dark pixels`);

    // the file list must not claim "5 of 4 pages" now that a page is doubled
    $('.dock-tab[data-panel="pages"]').click();
    await until(() => $('#filelist .row .sub'), 'the file list');
    const subEl = $('#filelist .row .sub');
    const summary = subEl.textContent;
    assert(!/\b5 of 4\b/.test(summary), `file list reads "${summary}"`);
    assert(/5 pages from a 4-page file/.test(summary), `file list reads "${summary}"`);
    // and it must be fully readable, not sliced off at the panel edge
    assert(subEl.scrollWidth <= subEl.clientWidth + 1,
      `the detail line is clipped: ${subEl.scrollWidth}px of text in ${subEl.clientWidth}px`);

    const { deletePages } = await import('/js/state.js');
    deletePages([state.pages[1]]);
    await until(() => state.pages.length === 4, 'cleanup');
    await until(() => /^4 pages/.test($('#filelist .row .sub').textContent), 'the count to settle');
    return `both copies inked (${inked.join(', ')}), list said "${summary}"`;
  });

  await check('select all highlights every tile', async () => {
    $('#btnSelectAll').click();
    await sleep(30);
    assert($$('#pagegrid .tile.sel').length === 4, `${$$('#pagegrid .tile.sel').length} tiles selected`);
    assert($('#selCount').textContent === '4 selected', `counter reads "${$('#selCount').textContent}"`);
    return '4 selected';
  });

  await check('rotate right turns the thumbnails', async () => {
    const before = $$('#pagegrid .tile canvas')[0];
    const portrait = before.height > before.width;
    assert(portrait, 'page 1 should start portrait');
    $('#btnRotR').click();
    await until(() => {
      const c = $$('#pagegrid .tile canvas')[0];
      return c && c.width > c.height;
    }, 'the thumbnail to turn');
    assert(state.pages[0].rot === 90, `state rotation is ${state.pages[0].rot}`);
    $('#btnRotL').click();
    await until(() => state.pages[0].rot === 0, 'rotation to go back');
    return 'portrait → landscape → portrait';
  });

  await check('clearing the selection empties the counter', async () => {
    $('#btnSelectNone').click();
    await sleep(30);
    assert($$('#pagegrid .tile.sel').length === 0, 'tiles are still selected');
    assert($('#selCount').textContent === '', `counter reads "${$('#selCount').textContent}"`);
    return 'cleared';
  });

  await check('the magnifier opens a page at full size', async () => {
    const first = $('#pagegrid .tile .expand span');
    assert(first, 'no magnifier button on the tile');
    first.click();
    await until(() => !$('#viewer').hidden, 'the viewer');
    await until(() => $('#viewerCanvas').width > 400, 'a full-size render');

    const canvas = $('#viewerCanvas');
    const sheet = $('#viewerSheet').getBoundingClientRect();
    const stage = $('#viewerStage').getBoundingClientRect();

    // "Fit" must land inside the stage, and be far bigger than a thumbnail.
    assert(sheet.height <= stage.height + 1, `page is ${sheet.height}px tall in a ${stage.height}px stage`);
    assert(sheet.width > 300, `page only rendered ${sheet.width}px wide`);
    assert($('#viewCount').textContent === 'Page 1 of 4', `counter reads "${$('#viewCount').textContent}"`);

    // and it must have real content, not a blank sheet
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, Math.min(canvas.height, 400));
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 200) dark++;
    assert(dark > 500, `the full-size page looks blank (${dark} dark pixels)`);
    return `${Math.round(sheet.width)}×${Math.round(sheet.height)} css, ${canvas.width}px bitmap`;
  });

  await check('arrow keys page through the document', async () => {
    const press = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    press('ArrowRight');
    await until(() => $('#viewCount').textContent === 'Page 2 of 4', 'page 2');
    press('ArrowRight');
    await until(() => $('#viewCount').textContent === 'Page 3 of 4', 'page 3');
    press('ArrowLeft');
    await until(() => $('#viewCount').textContent === 'Page 2 of 4', 'back to page 2');
    await settled();
    assert($('#viewerSheet').dataset.page === state.pages[1].uid, 'the sheet shows a different page');
    assert(!$('#viewPrev').disabled, 'previous should be available on page 2');
    return 'forwards and back';
  });

  await check('zooming changes the rendered size', async () => {
    await settled();
    const before = $('#viewerSheet').getBoundingClientRect().width;
    const shown = $('#viewZoom').textContent;
    $('#viewZoomIn').click();
    await until(() => $('#viewZoom').textContent !== shown, 'the zoom readout to move');
    await until(() => $('#viewerSheet').getBoundingClientRect().width > before + 10, 'a larger page');
    const after = $('#viewerSheet').getBoundingClientRect().width;

    $('#viewZoomOut').click();
    await until(() => $('#viewerSheet').getBoundingClientRect().width < after - 5, 'a smaller page');

    // Zooming past the top step must hold there, not wrap round to the smallest.
    for (let i = 0; i < 15; i++) $('#viewZoomIn').click();
    await settled();
    const maxed = $('#viewerSheet').getBoundingClientRect().width;
    assert(maxed > after, `zooming to the limit collapsed the page to ${Math.round(maxed)}px`);
    assert($('#viewZoomIn').disabled, 'zoom-in should be disabled at the maximum');

    // '0' returns to fit, which must sit inside the stage again
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
    await until(() => {
      const sheet = $('#viewerSheet').getBoundingClientRect();
      const stage = $('#viewerStage').getBoundingClientRect();
      return sheet.height <= stage.height + 1 && sheet.width > 100;
    }, 'fit to come back');
    return `${Math.round(before)}px → ${Math.round(after)}px → fit`;
  });

  await check('the viewer shows the watermark that will be exported', async () => {
    // page 2 is on screen; give it a mark and confirm the viewer draws it
    const { addStamps } = await import('/js/state.js');
    const page = state.pages[1];
    addStamps([page], [{ group: 'vw', type: 'text', text: 'VOID', font: 'HelveticaBold',
      size: 60, color: '#ff0000', opacity: 0.5, rot: 0, u: 0.5, v: 0.5 }]);
    await until(() => $$('#viewerStamps .st').length === 1, 'the mark in the viewer');
    const mark = $('#viewerStamps .st');
    assert(mark.textContent === 'VOID', `viewer shows "${mark.textContent}"`);

    const sheet = $('#viewerSheet').getBoundingClientRect();
    const size = parseFloat(getComputedStyle(mark).fontSize);
    const expected = (60 / 400) * sheet.width;   // page 2 of the fixture is 400 pt wide
    assert(Math.abs(size - expected) < 1.5,
      `viewer mark is ${size.toFixed(1)}px, geometry wants ${expected.toFixed(1)}px`);

    const { removeStampGroup } = await import('/js/state.js');
    removeStampGroup('vw');
    await until(() => $$('#viewerStamps .st').length === 0, 'cleanup');
    return `scaled to ${size.toFixed(1)}px on a ${Math.round(sheet.width)}px page`;
  });

  await check('rotating in the viewer turns the page and the thumbnail', async () => {
    const before = $('#viewerSheet').getBoundingClientRect();
    const portrait = before.height > before.width;
    assert(portrait, 'page 2 should start portrait');
    $('#viewRotR').click();
    await until(() => {
      const box = $('#viewerSheet').getBoundingClientRect();
      return box.width > box.height;
    }, 'the page to turn');
    assert(state.pages[1].rot === 90, `state rotation is ${state.pages[1].rot}`);
    $('#viewRotL').click();
    await until(() => state.pages[1].rot === 0, 'rotation to go back');
    return 'portrait → landscape → portrait';
  });

  await check('drawing in the viewer leaves a line on the page', async () => {
    await settled();
    const page = state.pages[1];
    const before = page.stamps.length;
    $('#viewDraw').click();
    assert($('#viewDraw').getAttribute('aria-pressed') === 'true', 'Draw did not switch on');
    assert(visible($('#viewPen')), 'no pen options while drawing');
    const ink = $('#viewerInk');
    const box = ink.getBoundingClientRect();
    const fire = (type, fx, fy) => ink.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, bubbles: true, cancelable: true,
      clientX: box.left + fx * box.width, clientY: box.top + fy * box.height }));
    fire('pointerdown', 0.2, 0.2);
    for (let i = 1; i <= 10; i++) fire('pointermove', 0.2 + i * 0.05, 0.2 + i * 0.02);
    fire('pointerup', 0.7, 0.4);
    await until(() => page.stamps.length === before + 1, 'the stroke to be kept');
    const stroke = page.stamps.at(-1);
    assert(stroke.type === 'ink' && stroke.points.length >= 10, `stored ${stroke.points?.length} points`);
    assert(Math.abs(stroke.points[0][0] - 0.2) < 0.01 && Math.abs(stroke.points[0][1] - 0.8) < 0.01,
      `line starts at ${stroke.points[0]}`);
    assert($$('#viewerStamps svg.ink').length === 1, 'the viewer does not show the line');
    assert(!$('#viewUndo').disabled, 'undo is not offered');
    return `${stroke.points.length} points kept`;
  });

  await check('typing in the viewer places text where it was clicked', async () => {
    const page = state.pages[1];
    const before = page.stamps.length;
    $('#viewType').click();
    assert($('#viewDraw').getAttribute('aria-pressed') === 'false', 'Draw stayed on with Text');
    const ink = $('#viewerInk');
    const box = ink.getBoundingClientRect();
    ink.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 8, bubbles: true, cancelable: true,
      clientX: box.left + box.width * 0.3, clientY: box.top + box.height * 0.6 }));
    await until(() => $('#viewerInk textarea'), 'a text box');
    const area = $('#viewerInk textarea');
    area.value = 'Signed off';
    area.dispatchEvent(new Event('input'));
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => page.stamps.length === before + 1, 'the text to be kept');
    const note = page.stamps.at(-1);
    assert(note.type === 'note' && note.text === 'Signed off' && note.bg === null, `stored ${JSON.stringify(note)}`);
    const left = note.u - note.w / 2;
    assert(Math.abs(left - 0.3) < 0.05, `text starts at u=${left.toFixed(3)}, clicked at 0.3`);
    assert(Math.abs(note.v - 0.4) < 0.05, `text sits at v=${note.v.toFixed(3)}, clicked at 0.4`);
    assert(!$('#viewerInk textarea'), 'the text box stayed open');
    return `placed at u=${left.toFixed(2)}, v=${note.v.toFixed(2)}`;
  });

  await check('undo takes back the latest mark, then the one before', async () => {
    const page = state.pages[1];
    const count = page.stamps.length;
    $('#viewUndo').click();
    await until(() => page.stamps.length === count - 1, 'one undo');
    assert(page.stamps.at(-1).type === 'ink', 'undo removed the wrong mark');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await until(() => page.stamps.length === count - 2, 'Ctrl+Z');
    assert($('#viewUndo').disabled, 'undo is still offered with nothing left');
    assert($$('#viewerStamps > *').length === 0, 'marks still drawn after undo');

    // Esc steps out of Text first, then closes.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert(!$('#viewer').hidden, 'Esc closed the viewer instead of leaving Text');
    assert($('#viewType').getAttribute('aria-pressed') === 'false', 'Text is still on');
    return 'both marks gone';
  });

  await check('escape closes the viewer and leaves the document alone', async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => $('#viewer').hidden, 'the viewer to close');
    assert(state.pages.length === 4, `document now has ${state.pages.length} pages`);
    assert(visible($('#workspace')), 'the grid did not come back');
    return 'closed, 4 pages intact';
  });

  await check('switching tools swaps the panel', async () => {
    $('.dock-tab[data-panel="mark"]').click();
    assert($('#panel-mark').classList.contains('active'), 'watermark panel did not open');
    assert(!$('#panel-pages').classList.contains('active'), 'organize panel stayed open');
    return 'Watermark panel open';
  });

  await check('adding a watermark previews it on every thumbnail', async () => {
    $('#wmValue').value = 'DRAFT COPY';
    $('#wmOp').value = '40';
    $('#btnWmApply').click();
    await until(() => $$('#pagegrid .stamps .st').length === 4, 'stamp previews to draw');
    const first = $('#pagegrid .stamps .st');
    assert(first.textContent === 'DRAFT COPY', `preview says "${first.textContent}"`);
    assert(state.pages.every((p) => p.stamps.length === 1), 'not every page got a stamp');
    assert($$('#stampList .row').length === 1, 'the queued-marks list is empty');
    // 48 pt on a 612 pt-wide page must preview as 48/612 of the thumbnail's width.
    const thumbWidth = first.closest('.thumb').getBoundingClientRect().width;
    const size = parseFloat(getComputedStyle(first).fontSize);
    const expected = (48 / 612) * thumbWidth;
    assert(Math.abs(size - expected) < 0.5,
      `preview is ${size.toFixed(1)}px but the page geometry wants ${expected.toFixed(1)}px`);

    // And the mark must not spill outside the page it is drawn on.
    const mark = first.getBoundingClientRect();
    const sheet = first.closest('.thumb').getBoundingClientRect();
    assert(mark.width <= sheet.width + 1, `mark is ${mark.width}px wide on a ${sheet.width}px page`);
    return `4 previews at ${size.toFixed(1)}px (geometry wants ${expected.toFixed(1)})`;
  });

  await check('removing the watermark clears the previews', async () => {
    $('#stampList .row button').click();
    await until(() => $$('#pagegrid .stamps .st').length === 0, 'previews to disappear');
    assert(state.pages.every((p) => p.stamps.length === 0), 'stamps left in state');
    return 'all clear';
  });

  await check('tiling a watermark lays down a grid of marks', async () => {
    $('#wmTile').checked = true;
    $('#wmTile').dispatchEvent(new Event('change'));
    $('#wmScope').querySelector('[data-v="sel"]').click();
    const { setSelection } = await import('/js/state.js');
    setSelection([state.pages[0].uid]);
    $('#btnWmApply').click();
    await until(() => state.pages[0].stamps.length === 12, 'a 3×4 tile grid');
    assert(state.pages[1].stamps.length === 0, 'tiling leaked onto an unselected page');
    $('#stampList .row button').click();
    await until(() => state.pages[0].stamps.length === 0, 'cleanup');
    $('#wmTile').checked = false;
    $('#wmTile').dispatchEvent(new Event('change'));
    $('#wmScope').querySelector('[data-v="all"]').click();
    setSelection([]);
    return '12 marks on one page only';
  });

  await check('the signature pad records strokes and places a signature', async () => {
    $('.dock-tab[data-panel="sign"]').click();
    const pad = $('#sigPad');
    const box = pad.getBoundingClientRect();
    const send = (type, fx, fy) => pad.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, bubbles: true, cancelable: true,
      clientX: box.left + box.width * fx,
      clientY: box.top + box.height * fy,
    }));
    send('pointerdown', 0.15, 0.7);
    for (let i = 1; i <= 12; i++) send('pointermove', 0.15 + i * 0.05, 0.7 - Math.sin(i / 2) * 0.25);
    send('pointerup', 0.75, 0.6);
    assert($('.padwrap').classList.contains('inked'), 'the pad does not look inked');

    $('#btnSigPlace').click();
    await until(() => !$('#placeModal').hidden, 'the placement dialog');
    const stage = $('#placeCanvas');
    assert(stage.width > 100, `placement render is ${stage.width}px wide`);
    assert($('#placeItem img').src.startsWith('blob:'), 'signature image missing');

    $('#placeConfirm').click();
    await until(() => state.pages[0].stamps.length === 1, 'the signature stamp');
    const stamp = state.pages[0].stamps[0];
    assert(stamp.type === 'image', `stamp type is ${stamp.type}`);
    assert(stamp.u > 0.5 && stamp.v < 0.5, `signature landed at u=${stamp.u}, v=${stamp.v}`);
    assert($('#placeModal').hidden, 'the dialog stayed open');
    assert($$('#pagegrid .stamps .st img').length === 1, 'no signature preview on the thumbnail');
    return `placed at u=${stamp.u.toFixed(2)}, v=${stamp.v.toFixed(2)}, ${(stamp.w * 100).toFixed(0)}% wide`;
  });

  await check('a note can be written and dragged onto a page', async () => {
    $('.dock-tab[data-panel="notes"]').click();
    assert($('#panel-notes').classList.contains('active'), 'notes panel did not open');
    $('#ntPage').value = state.pages[1].uid;
    $('#ntText').value = 'Check this figure before the review on Friday afternoon please';
    $('#btnNtPlace').click();
    await until(() => !$('#placeModal').hidden, 'the placement dialog');
    assert($('#placeTitle').textContent === 'Position your note', `dialog says "${$('#placeTitle').textContent}"`);
    const card = $('#placeItem .note-card');
    assert(card && card.textContent.includes('\n'), 'the long note did not wrap');
    assert(!$('#placeItem .grip').hidden, 'no resize grip on a note');

    // Pull the corner in: the note must rewrap onto more lines.
    const before = card.textContent.split('\n').length;
    const grip = $('#placeItem .grip').getBoundingClientRect();
    const fire = (type, x) => $('#placeItem .grip').dispatchEvent(new PointerEvent(type, {
      pointerId: 2, bubbles: true, cancelable: true, clientX: x, clientY: grip.top + 2 }));
    fire('pointerdown', grip.left + 2);
    fire('pointermove', grip.left - 60);
    fire('pointerup', grip.left - 60);
    const after = card.textContent.split('\n').length;
    assert(after > before, `narrowing kept ${after} lines (was ${before})`);

    $('#placeConfirm').click();
    await until(() => state.pages[1].stamps.length === 1, 'the note stamp');
    const stamp = state.pages[1].stamps[0];
    assert(stamp.type === 'note' && stamp.lines.length === after, `stored ${stamp.lines?.length} lines`);
    assert($$('#pagegrid .stamps .st.note').length === 1, 'no note preview on the thumbnail');
    assert($$('#noteList .row').length === 1, 'the note is not listed');
    assert(!$('#stampList').textContent.includes('Check this figure'), 'the note leaked into the watermark list');
    return `${after} lines after narrowing (was ${before})`;
  });

  await check('a sticky note is placed as an icon and can be removed', async () => {
    $('#ntKind').querySelector('[data-v="comment"]').click();
    assert(!$('#ntCommentStyle').hidden && $('#ntStyle').hidden, 'style controls did not swap');
    $('#ntText').value = 'Is this number right?';
    $('#btnNtPlace').click();
    await until(() => !$('#placeModal').hidden, 'the placement dialog');
    assert($('#placeItem .comment-pin'), 'no note icon to drag');
    assert($('#placeItem .grip').hidden, 'a sticky note should not resize');
    assert(!$('#placeItem .note-card'), 'the previous note card was left behind');
    $('#placeConfirm').click();
    await until(() => state.pages[1].stamps.length === 2, 'the comment stamp');
    assert($$('#pagegrid .stamps .st.comment').length === 1, 'no icon on the thumbnail');
    assert($$('#noteList .row').length === 2, 'the list did not grow');

    for (const btn of $$('#noteList .row button')) btn.click();
    await until(() => state.pages[1].stamps.length === 0, 'both notes to go');
    $('#ntKind').querySelector('[data-v="note"]').click();
    return 'placed, listed and removed';
  });

  await check('extracting text fills the panel', async () => {
    $('.dock-tab[data-panel="extract"]').click();
    $('#btnExtractText').click();
    await until(() => $('#exOut').value.includes('PAGEONE'), 'extracted text');
    assert($('#exOut').value.includes('page 1'), 'page markers missing');
    assert(!$('#btnSaveText').disabled, 'save button stayed disabled');
    return `${$('#exOut').value.length} characters`;
  });

  await check('finding images shows a gallery', async () => {
    $('#exKind').querySelector('[data-v="images"]').click();
    $('#btnExtractImages').click();
    await until(() => $$('#exImgGrid .imgcell').length >= 1, 'the image gallery', 300);
    const label = $('#exImgGrid .imgcell span').textContent;
    assert(label === '64×64', `gallery label reads "${label}"`);
    return label;
  });

  await check('optimizing an already-lean file admits it instead of growing it', async () => {
    state.pages[0].stamps = [];           // back to pristine
    $('.dock-tab[data-panel="compress"]').click();
    $('#btnCompress').click();
    await until(() => !$('#cmpResult').hidden, 'a compression result', 400);
    const text = $('#cmpResult').textContent;
    assert(/Already as small as it gets/.test(text), `result reads "${text}"`);
    assert($$('#cmpResult button').length === 1, 'expected a single "download the original" button');
    assert(/original/i.test($('#cmpResult button').textContent), 'button should offer the original');
    return text.replace(/\s+/g, ' ').slice(0, 56);
  });

  await check('shrinking hard reports a real before/after', async () => {
    $('#cmpMode').querySelector('[data-v="raster"]').click();
    assert(!$('#cmpRasterOpts').hidden, 'raster options did not appear');
    $('#cmpPreset').querySelector('[data-v="small"]').click();
    assert($('#cmpDpi').value === '72', `preset did not move the dpi slider (${$('#cmpDpi').value})`);
    assert($('#dpiOut').value === '72 dpi', `dpi readout says "${$('#dpiOut').value}"`);
    $('#btnCompress').click();
    await until(() => /→/.test($('#cmpResult').textContent), 'a before/after figure', 600);
    const text = $('#cmpResult').textContent;
    assert($$('#cmpResult button').length === 2, 'download / keep buttons missing');
    return text.replace(/\s+/g, ' ').slice(0, 56);
  });

  await check('the way back stays available while you work', () => {
    const back = $('.backlink');
    assert(visible(back), 'the link home disappeared once a file was open');
    const box = back.getBoundingClientRect();
    assert(box.top < 64 && box.left < 400, `link home sits at ${Math.round(box.left)},${Math.round(box.top)}`);
    return 'still in the top bar';
  });

  await check('start over is labeled and visible, not a bare "Clear"', () => {
    const reset = $('#btnReset');
    assert(visible(reset), 'the reset button is hidden while a document is open');
    assert(/start over/i.test(reset.textContent), `button reads "${reset.textContent.trim()}"`);
    assert(!/^\s*clear\s*$/i.test(reset.textContent), 'the button is still just "Clear"');
    assert(reset.querySelector('svg'), 'no icon on the reset button');

    // it must not be confusable with the selection control sitting right below
    const other = $('#btnSelectNone').textContent.trim();
    assert(other !== reset.textContent.trim(), 'reset and deselect share a label');

    // and it should actually be visible, not a transparent ghost
    const border = getComputedStyle(reset).borderTopColor;
    assert(border !== 'rgba(0, 0, 0, 0)' && border !== 'transparent',
      `the reset button has no visible edge (${border})`);
    return `"${reset.textContent.trim()}" with a border`;
  });

  await check('start over empties the workspace and returns to the drop zone', async () => {
    $('#btnReset').click();
    await until(() => state.pages.length === 0, 'the workspace to empty');
    assert(visible($('#dropzone')), 'drop zone did not come back');
    assert(!visible($('#dock')), 'tool dock is still showing');
    assert($$('#pagegrid .tile').length === 0, 'tiles left behind');
    assert(state.sources.size === 0, 'sources left behind');
    return 'back to empty';
  });

  return results;
}
