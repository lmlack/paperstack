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
    for (const sel of ['#signDialog', '#busy', '#workspace', '#dock', '#stats', '#btnExport', '#btnReset']) {
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

    return 'in the top bar';
  });

  await check('the explanatory text is big enough to read', () => {
    const px = (sel) => parseFloat(getComputedStyle($(sel)).fontSize);
    const floors = {
      '.dz-inner p': 16,
      '.hint': 15,           // the one-line explainer under each tool
      'body': 16,
    };
    for (const [sel, floor] of Object.entries(floors)) {
      assert($(sel), `${sel} is missing`);
      assert(px(sel) >= floor, `${sel} is ${px(sel)}px, under the ${floor}px floor`);
    }
    return `drop zone ${px('.dz-inner p')}px, hints ${px('.hint')}px, body ${px('body')}px`;
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
    assert($('#selCount').textContent === '4 of 4 selected', `counter reads "${$('#selCount').textContent}"`);
    assert(visible($('#selActions')), 'no actions for the selection');
    return '4 of 4 selected, with actions';
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

  await check('swiping across the page turns it, and a short drag does not', async () => {
    const stage = $('#viewerStage');
    const sheet = $('#viewerSheet').getBoundingClientRect();
    const y = sheet.top + sheet.height * 0.5;
    const swipe = (from, to) => {
      const touch = (x) => new Touch({ identifier: 11, target: stage, clientX: x, clientY: y });
      const fire = (type, x) => stage.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [touch(x)], changedTouches: [touch(x)] }));
      fire('touchstart', from);
      for (let i = 1; i <= 6; i++) fire('touchmove', from + ((to - from) * i) / 6);
      fire('touchend', to);
    };
    const mid = sheet.left + sheet.width / 2;
    swipe(mid + 120, mid - 120);   // right to left: forwards
    await until(() => $('#viewCount').textContent === 'Page 3 of 4', 'a swipe to page 3');
    await settled();
    swipe(mid - 120, mid + 120);   // left to right: back
    await until(() => $('#viewCount').textContent === 'Page 2 of 4', 'a swipe back to page 2');
    await settled();
    swipe(mid, mid - 30);          // too short to count
    await sleep(300);
    assert($('#viewCount').textContent === 'Page 2 of 4', 'a nudge turned the page');
    assert(!$('#viewerSheet').style.translate, 'the page did not spring back');
    return 'forwards, back, and a nudge ignored';
  });

  await check('a double tap zooms in on the page, and the next one fits it again', async () => {
    await settled();
    const fit = $('#viewerSheet').getBoundingClientRect();
    assert($('#viewFit').textContent === 'Fit width', `at fit the button reads "${$('#viewFit').textContent}"`);
    const tap = (x, y) => $('#viewerStage').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }));
    tap(fit.left + fit.width * 0.3, fit.top + fit.height * 0.3);
    await until(() => $('#viewerSheet').getBoundingClientRect().width > fit.width * 1.5, 'a closer look');
    await settled();
    assert($('#viewFit').textContent === 'Fit page', `zoomed in, the button reads "${$('#viewFit').textContent}"`);
    tap(fit.left + 10, fit.top + 10);
    await until(() => Math.abs($('#viewerSheet').getBoundingClientRect().width - fit.width) < 2, 'the whole page again');
    await settled();
    return `${Math.round(fit.width)}px → zoomed → ${Math.round(fit.width)}px`;
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
    assert($('#viewType').getAttribute('aria-pressed') === 'false', 'Text stayed on after placing');
    return `placed at u=${left.toFixed(2)}, v=${note.v.toFixed(2)}`;
  });

  await check('a placed mark can be picked up, moved and deleted', async () => {
    const before = state.pages[1].stamps.length;
    $('#viewSelect').click();
    assert($('#viewSelect').getAttribute('aria-pressed') === 'true', 'Select did not switch on');
    const node = $('#viewerStamps .st.note');
    assert(node, 'the typed text is not drawn');
    const box = node.getBoundingClientRect();
    const sheet = $('#viewerStamps').getBoundingClientRect();
    const fire = (type, dx) => node.dispatchEvent(new PointerEvent(type, {
      pointerId: 9, bubbles: true, cancelable: true,
      clientX: box.left + box.width / 2 + dx, clientY: box.top + box.height / 2 }));
    const u0 = state.pages[1].stamps.at(-1).u;
    fire('pointerdown', 0);
    for (let i = 1; i <= 5; i++) fire('pointermove', i * 12);
    fire('pointerup', 60);
    await until(() => Math.abs(state.pages[1].stamps.at(-1).u - u0) > 0.01, 'the text to move');
    const moved = state.pages[1].stamps.at(-1).u - u0;
    assert(Math.abs(moved - 60 / sheet.width) < 0.01, `moved by ${moved.toFixed(3)}, wanted ${(60 / sheet.width).toFixed(3)}`);
    assert($('#viewerStamps .st.note.picked'), 'the moved mark is not shown as selected');
    assert(visible($('#viewPicked')), 'no delete button for the selected mark');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    await until(() => state.pages[1].stamps.length === before - 1, 'Delete to remove it');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    await until(() => state.pages[1].stamps.length === before, 'Ctrl+Z to bring it back');
    assert(Math.abs(state.pages[1].stamps.at(-1).u - (u0 + moved)) < 1e-6, 'undo did not restore the moved spot');
    return `moved ${(moved * 100).toFixed(1)}% across, deleted, restored`;
  });

  await check('undo and redo step through every change', async () => {
    const count = state.pages[1].stamps.length;
    $('#viewUndo').click();   // the move
    $('#viewUndo').click();   // the typed text
    await until(() => state.pages[1].stamps.length === count - 1, 'one mark gone');
    assert(state.pages[1].stamps.at(-1).type === 'ink', 'undo removed the wrong mark');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    await until(() => state.pages[1].stamps.length === count - 2, 'Ctrl+Z');
    await until(() => $$('#viewerStamps > *').length === 0, 'marks to leave the page');
    assert(!$('#viewRedo').disabled, 'redo is not offered');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    await until(() => state.pages[1].stamps.length === count - 1, 'Ctrl+Shift+Z');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    await until(() => state.pages[1].stamps.length === count - 2, 'undo again');
    return 'undone, redone, undone';
  });

  await check('a sticky note can be left right on the page', async () => {
    $('#viewNote').click();
    assert($('#viewNote').getAttribute('aria-pressed') === 'true', 'Sticky note did not switch on');
    const ink = $('#viewerInk');
    const box = ink.getBoundingClientRect();
    ink.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 10, bubbles: true, cancelable: true,
      clientX: box.left + box.width * 0.8, clientY: box.top + box.height * 0.25 }));
    await until(() => $('#viewerInk textarea.sticky-editor'), 'the sticky note card');
    const area = $('#viewerInk textarea.sticky-editor');
    area.value = 'Is this right? ✓';
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await until(() => state.pages[1].stamps.some((s) => s.type === 'comment'), 'the comment');
    const note = state.pages[1].stamps.find((s) => s.type === 'comment');
    assert(note.text === 'Is this right? ✓', `kept "${note.text}"`);
    assert(Math.abs(note.u - 0.8) < 0.01 && Math.abs(note.v - 0.75) < 0.01, `pinned at ${note.u}, ${note.v}`);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    await until(() => !state.pages[1].stamps.some((s) => s.type === 'comment'), 'undo');

    // Placing it put the tool down, so a swipe turns the page again.
    assert($('#viewSelect').getAttribute('aria-pressed') === 'true', 'the tool stayed on after placing the note');
    assert($('#viewDone').hidden, 'Done is showing with no tool in hand');

    // Draw stays on for stroke after stroke; Done and Esc both put it down.
    $('#viewDraw').click();
    assert(visible($('#viewDone')), 'no Done button while drawing');
    $('#viewDone').click();
    assert($('#viewSelect').getAttribute('aria-pressed') === 'true', 'Done did not go back to Select');
    $('#viewDraw').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert(!$('#viewer').hidden, 'Esc closed the viewer instead of leaving the tool');
    assert($('#viewSelect').getAttribute('aria-pressed') === 'true', 'Esc did not go back to Select');
    return 'pinned where clicked, tool put down after';
  });

  await check('escape closes the viewer and leaves the document alone', async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => $('#viewer').hidden, 'the viewer to close');
    assert(state.pages.length === 4, `document now has ${state.pages.length} pages`);
    assert(visible($('#workspace')), 'the grid did not come back');
    return 'closed, 4 pages intact';
  });

  await check('a deleted page comes back with Undo on the toast', async () => {
    const second = state.pages[1].uid;
    $$('#pagegrid .tile')[1].querySelector('.acts .rm').click();
    await until(() => state.pages.length === 3, 'the page to go');
    const undo = [...$$('.toast-act')].find((b) => b.textContent === 'Undo');
    assert(undo, 'the toast offers no Undo');
    undo.click();
    await until(() => state.pages.length === 4, 'the page to come back');
    assert(state.pages[1].uid === second, 'it came back in the wrong place');
    return 'deleted and restored in place';
  });

  await check('a blank page goes in between pages, sized like its neighbor', async () => {
    const n = state.pages.length;
    const second = state.pages[1].uid;
    const slot = $$('#pagegrid .tile')[1].querySelector('.slot');
    slot.click();
    const item = await until(() => [...$$('.popmenu-item')].find((b) => b.textContent.includes('Blank page')), 'the insert menu');
    assert(item, 'no Blank page choice');
    [...$$('.popmenu-item')].find((b) => b.textContent.includes('Blank page')).click();
    await until(() => state.pages.length === n + 1, 'the blank page');
    const blank = state.pages[1];
    assert(state.pages[2].uid === second, 'the old page 2 did not move along');
    assert(state.sources.get(blank.srcId).name.startsWith('Blank'), 'page 2 is not the blank page');
    const { displayInfo } = await import('/js/assemble.js');
    const [a, b] = await Promise.all([displayInfo(blank), displayInfo(state.pages[0])]);
    assert(Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1, `blank is ${a.w}×${a.h}, its neighbor ${b.w}×${b.h}`);
    assert([...$$('.toast-act')].some((x) => x.textContent === 'Edit it'), 'no way to edit it from the message');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    await until(() => state.pages.length === n, 'undo');
    return `${Math.round(a.w)}×${Math.round(a.h)} pt, as page 2`;
  });

  await check('a file dropped between pages goes in right there', async () => {
    const n = state.pages.length;
    const bytes = await fetch('/test/fixture.pdf').then((r) => r.arrayBuffer());
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'appendix.pdf', { type: 'application/pdf' }));
    const target = $$('#pagegrid .tile')[2];
    const box = target.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, dataTransfer: data, clientX: box.left + 5, clientY: box.top + 40 };
    target.querySelector('.thumb').dispatchEvent(new DragEvent('dragover', at));
    assert(target.classList.contains('drop-before'), 'no marker where the file will go');
    target.querySelector('.thumb').dispatchEvent(new DragEvent('drop', at));
    await until(() => state.pages.length === n + 4, 'the dropped pages');
    const names = state.pages.map((p) => state.sources.get(p.srcId).name);
    assert(names.slice(2, 6).every((x) => x === 'appendix.pdf'), `pages 3–6 came from ${names.slice(2, 6)}`);
    assert(names[1] !== 'appendix.pdf' && names[6] !== 'appendix.pdf', 'it did not land between pages 2 and 3');
    assert($$('#pagegrid .srcdot').length === state.pages.length, 'pages do not show which file they came from');
    return 'four pages in at page 3, each marked with its file';
  });

  await check('a file’s pages are picked out and moved by number', async () => {
    const appendix = [...$$('#filelist .row-open')].find((b) => b.textContent.includes('appendix.pdf'));
    assert(appendix, 'the added file is not listed');
    appendix.click();
    assert(state.sel.size === 4, `${state.sel.size} pages selected`);
    $('#selMove').click();
    const input = await until(() => $('.moveform input'), 'the Move form');
    $('.moveform input').value = '1';
    [...$$('.moveform button')].find((b) => b.textContent === 'Move').click();
    await until(() => state.sources.get(state.pages[0].srcId).name === 'appendix.pdf', 'the move');
    const names = state.pages.map((p) => state.sources.get(p.srcId).name);
    assert(names.slice(0, 4).every((x) => x === 'appendix.pdf'), `the start is now ${names.slice(0, 4)}`);
    // The Organize panel's box: the page asked for is the page it becomes.
    const { deletePages, setSelection } = await import('/js/state.js');
    $('.dock-tab[data-panel="pages"]').click();
    const last = state.pages.at(-1);
    setSelection([last.uid]);
    $('#moveTo').value = '3';
    $('#btnMoveTo').click();
    await until(() => state.pages[2] === last, 'the last page to become page 3');
    assert($$('.toast').some((t) => t.textContent.includes('to page 3')), 'the message does not say where it went');
    setSelection([]);
    assert($('#btnMoveTo').disabled, 'Move is offered with nothing selected');

    // Put things back as they were for the checks that follow.
    deletePages(state.pages.filter((p) => state.sources.get(p.srcId).name === 'appendix.pdf'));
    const { movePagesTo } = await import('/js/state.js');
    movePagesTo([last], 3);
    setSelection([]);
    await until(() => state.pages.length === 4 && state.pages[3] === last, 'cleanup');
    return 'moved to the front by page number';
  });

  await check('pages can be saved as pictures', async () => {
    const saved = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { saved.push({ name: this.download, href: this.href }); };
    try {
      const { setSelection } = await import('/js/state.js');
      setSelection([state.pages[0].uid]);
      $('#btnExportMore').click();
      [...$$('.popmenu-item')].find((b) => b.textContent.includes('JPG')).click();
      await until(() => saved.length === 1, 'a download', 300);
      const bytes = new Uint8Array(await fetch(saved[0].href).then((r) => r.arrayBuffer()));
      assert(bytes[0] === 0xff && bytes[1] === 0xd8, 'that is not a JPEG');
      assert(/-page-1\.jpg$/.test(saved[0].name), `named ${saved[0].name}`);

      setSelection([]);
      $('#btnExportMore').click();
      [...$$('.popmenu-item')].find((b) => b.textContent.includes('PNG')).click();
      await until(() => saved.length === 2, 'a second download', 300);
      assert(saved[1].name.endsWith('-png.zip'), `named ${saved[1].name}`);
      return `${saved[0].name}, ${(bytes.length / 1024).toFixed(0)} KB; then every page as PNGs in a zip`;
    } finally {
      HTMLAnchorElement.prototype.click = click;
    }
  });

  await check('each page offers a labeled way to edit it', async () => {
    const pill = $('#pagegrid .tile .expand');
    assert(pill.textContent.trim() === 'Edit', `the button reads "${pill.textContent.trim()}"`);
    assert(pill.getAttribute('aria-label') === 'Edit page 1', `labeled "${pill.getAttribute('aria-label')}"`);
    return 'Edit, on every page';
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

  await check('a signature is made in its dialog and lands on the page, ready to move', async () => {
    $('.dock-tab[data-panel="sign"]').click();
    $('#btnSigNew').click();
    await until(() => visible($('#signDialog')), 'the signature dialog');
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

    $('#signConfirm').click();
    await until(() => state.pages[0].stamps.length === 1, 'the signature stamp');
    const stamp = state.pages[0].stamps[0];
    assert(stamp.type === 'image' && stamp.role === 'signature', `stamp is ${stamp.type}/${stamp.role}`);
    assert(stamp.u > 0.5 && stamp.v < 0.5, `signature landed at u=${stamp.u}, v=${stamp.v}`);
    assert($('#signDialog').hidden, 'the dialog stayed open');
    await until(() => !$('#viewer').hidden && $('#viewerStamps .st.picked img'), 'the page to open with it selected');
    await settled();

    // Pull the corner out: it grows, and its top-left corner stays put.
    const node = $('#viewerStamps .st.picked');
    const grip = node.querySelector('.grip');
    assert(grip, 'no resize grip on a signature');
    const g = grip.getBoundingClientRect();
    const w0 = state.pages[0].stamps[0].w;
    const left0 = node.getBoundingClientRect().left;
    const fire = (type, dx) => grip.dispatchEvent(new PointerEvent(type, {
      pointerId: 3, bubbles: true, cancelable: true, clientX: g.left + 4 + dx, clientY: g.top + 4 }));
    fire('pointerdown', 0);
    fire('pointermove', -10);
    fire('pointermove', -40);
    fire('pointerup', -40);
    await until(() => state.pages[0].stamps[0].w < w0 - 0.01, 'the signature to shrink');
    await until(() => $('#viewerStamps .st.picked'), 'it to stay selected');
    const left1 = $('#viewerStamps .st.picked').getBoundingClientRect().left;
    assert(Math.abs(left1 - left0) < 2, `its left edge moved from ${left0} to ${left1}`);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => $('#viewer').hidden, 'the editor to close');
    assert($$('#pagegrid .stamps .st img').length === 1, 'no signature preview on the thumbnail');
    assert($$('#sigList .sigcard').length === 1, 'the signature was not kept for reuse');
    assert($$('#sigPlaced .row').length === 1, 'the placed signature is not listed');
    assert(!$('#stampList').textContent.includes('Image'), 'the signature shows up as a watermark');
    return `placed at u=${stamp.u.toFixed(2)}, v=${stamp.v.toFixed(2)}, resized to ${(state.pages[0].stamps[0].w * 100).toFixed(0)}% wide`;
  });

  await check('a note is written in the panel and rewraps when pulled narrower', async () => {
    $('.dock-tab[data-panel="notes"]').click();
    assert($('#panel-notes').classList.contains('active'), 'notes panel did not open');
    $('#ntPage').value = state.pages[1].uid;
    $('#ntText').value = 'Check this figure before the review on Friday afternoon please';
    $('#btnNtPlace').click();
    await until(() => state.pages[1].stamps.length === 1, 'the note stamp');
    await until(() => !$('#viewer').hidden && $('#viewerStamps .st.note.picked'), 'the page to open with it selected');
    await settled();
    await sleep(250);   // the note's font metrics load when it is picked
    const before = state.pages[1].stamps[0].lines.length;
    assert(before > 1, 'the long note did not wrap');

    const grip = $('#viewerStamps .st.picked .grip');
    assert(grip, 'no resize grip on a note');
    const g = grip.getBoundingClientRect();
    const fire = (type, dx) => grip.dispatchEvent(new PointerEvent(type, {
      pointerId: 2, bubbles: true, cancelable: true, clientX: g.left + 4 + dx, clientY: g.top + 4 }));
    fire('pointerdown', 0);
    fire('pointermove', -30);
    fire('pointermove', -80);
    fire('pointerup', -80);
    await until(() => state.pages[1].stamps[0].lines.length > before, 'the note to rewrap');
    const after = state.pages[1].stamps[0].lines.length;

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => $('#viewer').hidden, 'the editor to close');
    assert($$('#pagegrid .stamps .st.note').length === 1, 'no note preview on the thumbnail');
    assert($$('#noteList .row').length === 1, 'the note is not listed');
    assert(!$('#stampList').textContent.includes('Check this figure'), 'the note leaked into the watermark list');
    return `${after} lines after narrowing (was ${before})`;
  });

  await check('a sticky note from the panel is placed as an icon and can be removed', async () => {
    $('#ntKind').querySelector('[data-v="comment"]').click();
    assert(!$('#ntCommentStyle').hidden && $('#ntStyle').hidden, 'style controls did not swap');
    $('#ntText').value = 'Is this number right?';
    $('#btnNtPlace').click();
    await until(() => state.pages[1].stamps.length === 2, 'the comment stamp');
    await until(() => !$('#viewer').hidden && $('#viewerStamps .st.comment.picked'), 'the page to open with it selected');
    assert(!$('#viewerStamps .st.comment .grip'), 'a sticky note should not resize');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => $('#viewer').hidden, 'the editor to close');
    assert($$('#pagegrid .stamps .st.comment').length === 1, 'no icon on the thumbnail');
    assert($$('#noteList .row').length === 2, 'the list did not grow');

    for (const btn of $$('#noteList .row > button')) btn.click();
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

  await check('the empty screen starts a blank page, open and ready to write on', async () => {
    assert(!$('.dz-home'), 'the gwark.dev line is still under the drop zone');
    $('[data-blank="a4"]').click();
    await until(() => state.pages.length === 1 && !$('#viewer').hidden, 'the editor on a blank page');
    await settled();
    const { displayInfo } = await import('/js/assemble.js');
    const { w, h } = await displayInfo(state.pages[0]);
    assert(Math.round(w) === 595 && Math.round(h) === 842, `the page is ${w}×${h} pt, not A4`);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => $('#viewer').hidden, 'the editor to close');
    assert(visible($('#workspace')), 'no page grid behind it');
    $('#btnReset').click();
    await until(() => state.pages.length === 0, 'start over');
    return 'A4, 595×842 pt, in the editor';
  });

  return results;
}
