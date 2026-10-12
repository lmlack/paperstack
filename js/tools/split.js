// Splitting. One output file goes straight to disk; several are bundled into a
// zip built in-page by js/lib/zip.js.

import { $, bindRange, download, safeName, parseRangeGroups } from '../lib/dom.js';
import { state } from '../state.js';
import { assemble } from '../assemble.js';
import { makeZip } from '../lib/zip.js';
import { withBusy, toast } from '../ui/feedback.js';

export function initSplit() {
  const mode = $('#spMode');
  const sync = () => {
    $('#spRangesWrap').hidden = mode.value !== 'ranges';
    $('#spEveryWrap').hidden = mode.value !== 'every';
  };
  mode.addEventListener('change', sync);
  sync();

  bindRange($('#spEvery'), $('#spEveryOut'));
  $('#btnSplit').onclick = () => run(mode.value);
}

/** Decides the page groups for the chosen mode. Each group becomes one PDF. */
function groupsFor(mode) {
  const pages = state.pages;
  if (mode === 'sel') {
    const chosen = pages.filter((p) => state.sel.has(p.uid));
    if (!chosen.length) throw new Error('Select the pages you want to pull out first.');
    return [{ label: 'selection', pages: chosen }];
  }
  if (mode === 'ranges') {
    return parseRangeGroups($('#spRanges').value, pages.length)
      .map((indices) => ({
        label: indices.length > 1 ? `${indices[0] + 1}-${indices.at(-1) + 1}` : `${indices[0] + 1}`,
        pages: indices.map((i) => pages[i]),
      }));
  }
  if (mode === 'every') {
    const size = Number($('#spEvery').value);
    const out = [];
    for (let i = 0; i < pages.length; i += size) {
      const slice = pages.slice(i, i + size);
      out.push({ label: `${i + 1}-${i + slice.length}`, pages: slice });
    }
    return out;
  }
  return pages.map((page, i) => ({ label: String(i + 1).padStart(String(pages.length).length, '0'), pages: [page] }));
}

async function run(mode) {
  let groups;
  try {
    groups = groupsFor(mode);
  } catch (err) {
    toast(err.message, 'err');
    return;
  }

  const stem = safeName(state.outName);
  await withBusy('Splitting…', async (ui) => {
    const files = [];
    for (let i = 0; i < groups.length; i++) {
      ui.label(`Writing file ${i + 1} of ${groups.length}…`);
      ui.step(i, groups.length);
      const bytes = await assemble(groups[i].pages);
      files.push({ name: `${stem}-${groups[i].label}.pdf`, bytes });
    }

    if (files.length === 1) {
      download(new Blob([files[0].bytes], { type: 'application/pdf' }), files[0].name);
      toast(`Saved ${files[0].name}`, 'ok');
      return;
    }
    download(makeZip(files), `${stem}-split.zip`);
    toast(`Saved ${files.length} files as a zip.`, 'ok');
  });
}
