// App bootstrap: file intake, the tool dock, export, theme and shortcuts.

import { $, $$, fmtBytes, download, safeName } from './lib/dom.js';
import { state, on, addPdf, addImageAsPage, reset, setSelection, totalBytes, targetPages, rotatePages, deletePages } from './state.js';
import { assemble } from './assemble.js';
import { renderGrid } from './ui/pagegrid.js';
import { initViewer } from './ui/viewer.js';
import { toast, withBusy } from './ui/feedback.js';
import { initOrganize } from './tools/organize.js';
import { initCompress } from './tools/compress.js';
import { initWatermark } from './tools/watermark.js';
import { initSign } from './tools/sign.js';
import { initExtract } from './tools/extract.js';
import { initSplit } from './tools/split.js';

/* ───────────────────────── file intake ───────────────────────── */

async function intake(files) {
  const list = [...files];
  const pdfs = list.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const images = list.filter((f) => f.type.startsWith('image/'));
  const ignored = list.length - pdfs.length - images.length;

  if (!pdfs.length && !images.length) {
    toast('Drop a PDF (or an image to add as a page).', 'err');
    return;
  }

  await withBusy('Opening…', async (ui) => {
    const total = pdfs.length + images.length;
    let done = 0;
    const failures = [];

    for (const file of pdfs) {
      ui.label(`Opening ${file.name}…`);
      ui.step(done, total);
      try { await addPdf(file); } catch (err) { failures.push(err.message); }
      done++;
    }
    for (const file of images) {
      ui.label(`Converting ${file.name}…`);
      ui.step(done, total);
      try { await addImageAsPage(file); } catch { failures.push(`${file.name} could not be read.`); }
      done++;
    }
    for (const message of failures) toast(message, 'err', 7000);
  });

  if (ignored) toast(`Skipped ${ignored} file${ignored === 1 ? '' : 's'} that wasn’t a PDF or image.`);
}

$('#fileInput').addEventListener('change', (e) => {
  intake(e.target.files);
  e.target.value = '';
});
$('#imageInput').addEventListener('change', (e) => {
  intake(e.target.files);
  e.target.value = '';
});

/* ───────────────────────── drag and drop ───────────────────────── */

const dropzone = $('#dropzone');
let dragDepth = 0;

window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  dropzone.classList.add('hot');
});
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropzone.classList.remove('hot');
});
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('hot');
  intake(e.dataTransfer.files);
});

/* ───────────────────────── chrome ───────────────────────── */

function syncChrome() {
  const has = state.pages.length > 0;
  $('#layout').classList.toggle('has-doc', has);
  $('#workspace').hidden = !has;
  $('#dock').hidden = !has;
  $('#stats').hidden = !has;
  $('#btnExport').hidden = !has;
  $('#btnReset').hidden = !has;
  $('#addFilesBtn').hidden = !has;

  if (!has) return;
  const n = state.pages.length;
  $('#statPages').textContent = `${n} page${n === 1 ? '' : 's'}`;
  $('#statFiles').textContent = `${state.sources.size} file${state.sources.size === 1 ? '' : 's'}`;
  $('#statSize').textContent = fmtBytes(totalBytes());
}

$$('.dock-tab').forEach((tab) => {
  tab.onclick = () => {
    $$('.dock-tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab.dataset.panel}`));
  };
});

$('#btnReset').onclick = () => {
  const n = state.pages.length;
  if (!confirm(`Close every file and start over?\n\n${n} page${n === 1 ? '' : 's'} and any watermarks or signatures you have queued will be discarded. Export first if you want to keep them.`)) return;
  reset();
  toast('Cleared. Drop a new PDF whenever you like.');
};

/* ───────────────────────── export ───────────────────────── */

async function exportPdf() {
  const name = `${safeName(state.outName) || 'document'}-edited.pdf`;
  await withBusy('Writing PDF…', async (ui) => {
    const bytes = await assemble(state.pages, (done, total) => {
      ui.label(`Writing page ${done} of ${total}…`);
      ui.step(done, total);
    });
    download(new Blob([bytes], { type: 'application/pdf' }), name);
    toast(`Saved ${name} · ${fmtBytes(bytes.length)}`, 'ok');
  });
}

$('#btnExport').onclick = exportPdf;

/* ───────────────────────── theme ───────────────────────── */

const THEME_KEY = 'paperstack.theme';
const root = document.documentElement;

try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) root.dataset.theme = saved;
  else if (window.matchMedia('(prefers-color-scheme: light)').matches) root.dataset.theme = 'light';
} catch { /* private mode: stay on the default */ }

$('#themeToggle').onclick = () => {
  root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, root.dataset.theme); } catch { /* ignore */ }
};

/* ───────────────────────── keyboard ───────────────────────── */

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  // The viewer handles its own keys while it is open.
  if (typing || !state.pages.length || !$('#viewer').hidden) return;
  const meta = e.metaKey || e.ctrlKey;

  if (meta && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    setSelection(state.pages.map((p) => p.uid));
  } else if (meta && e.key.toLowerCase() === 's') {
    e.preventDefault();
    exportPdf();
  } else if (e.key === 'Escape') {
    setSelection([]);
  } else if (e.key === '[') {
    rotatePages(targetPages(), -90);
  } else if (e.key === ']') {
    rotatePages(targetPages(), 90);
  } else if ((e.key === 'Backspace' || e.key === 'Delete') && state.sel.size) {
    e.preventDefault();
    const doomed = targetPages();
    if (doomed.length < state.pages.length) deletePages(doomed);
    else toast('That would delete every page.', 'err');
  }
});

/* ───────────────────────── go ───────────────────────── */

on('pages', syncChrome);
on('sources', syncChrome);

initViewer();
initOrganize();
initCompress();
initWatermark();
initSign();
initExtract();
initSplit();

renderGrid();
syncChrome();

// A half-finished edit is easy to lose by reflex; nothing is stored server-side.
window.addEventListener('beforeunload', (e) => {
  if (!state.pages.length) return;
  e.preventDefault();
  e.returnValue = '';
});
