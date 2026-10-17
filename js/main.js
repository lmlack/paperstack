// App bootstrap: file intake, the tool dock, export, theme and shortcuts.

import { $, $$, fmtBytes, download, safeName } from './lib/dom.js';
import { state, on, reset, setSelection, totalBytes, targetPages, rotatePages, liveSources } from './state.js';
import { assemble } from './assemble.js';
import { renderGrid, deleteWithUndo } from './ui/pagegrid.js';
import { initViewer } from './ui/viewer.js';
import { initHistory, historyKey } from './ui/history.js';
import { intake, initIntake } from './ui/intake.js';
import { openMenu } from './ui/menu.js';
import { exportImages, imageScope } from './tools/images.js';
import { toast, withBusy } from './ui/feedback.js';
import { initOrganize } from './tools/organize.js';
import { initCompress } from './tools/compress.js';
import { initWatermark } from './tools/watermark.js';
import { initSign } from './tools/sign.js';
import { initNotes } from './tools/notes.js';
import { initExtract } from './tools/extract.js';
import { initSplit } from './tools/split.js';

/* ───────────────────────── iOS focus zoom ───────────────────────── */

// iOS zooms the whole page in when a text box with type under 16px gets the
// focus, and leaves it zoomed. maximum-scale=1 stops that, and iOS still lets
// people pinch to zoom whatever it says. Other browsers would honor it as a
// pinch lock, so it is set for iOS alone.
if (/iP(hone|ad|od)/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
  $('meta[name="viewport"]').content = 'width=device-width, initial-scale=1, maximum-scale=1';
}

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
  dragDepth = 0;
  dropzone.classList.remove('hot');
  // A drop onto the page grid has already gone in where it was aimed.
  if (e.defaultPrevented || !e.dataTransfer?.files?.length) return;
  e.preventDefault();
  intake(e.dataTransfer.files);
});

/* ───────────────────────── chrome ───────────────────────── */

function syncChrome() {
  const has = state.pages.length > 0;
  $('#layout').classList.toggle('has-doc', has);
  $('#workspace').hidden = !has;
  $('#dock').hidden = !has;
  $('#stats').hidden = !has;
  $('#exportGroup').hidden = !has;
  $('#btnShare').hidden = !has || !canShareFiles;
  $('#btnReset').hidden = !has;
  $('#addFilesBtn').hidden = !has;

  if (!has) return;
  const n = state.pages.length;
  $('#statPages').textContent = `${n} page${n === 1 ? '' : 's'}`;
  const files = liveSources().length;
  $('#statFiles').textContent = `${files} file${files === 1 ? '' : 's'}`;
  $('#statSize').textContent = fmtBytes(totalBytes());
}

$$('.dock-tab').forEach((tab) => {
  tab.onclick = () => {
    $$('.dock-tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab.dataset.panel}`));
  };
});

$('#btnReset').onclick = () => {
  const n = state.pages.length;
  if (!confirm(`Close every file and start over?\n\n${n} page${n === 1 ? '' : 's'} and any watermarks or signatures you have queued will be discarded. Export first if you want to keep them.`)) return;
  reset();
  toast('Cleared. Drop in a PDF to start again.');
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

// The arrow beside Export: the same document as pictures, for a slide, a chat
// or an email body.
const PICTURE = '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-5 4 4 2.5-2.5L20 17"/></svg>';
const DOC = '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>';
$('#btnExportMore').onclick = () => openMenu($('#btnExportMore'), [
  { label: 'PDF', hint: 'The whole document (⌘S)', icon: DOC, run: exportPdf },
  { label: 'JPG images', hint: imageScope(), icon: PICTURE, run: () => exportImages('jpg') },
  { label: 'PNG images', hint: `${imageScope()}, lossless`, icon: PICTURE, run: () => exportImages('png') },
], { label: 'Export as' });

/* ───────────────────────── share ───────────────────────── */

// The system share sheet: AirDrop, Mail, Messages and so on, whatever the
// device offers. The file goes straight from this tab to the OS, so the
// no-upload promise holds. Browsers without file sharing (Firefox desktop)
// never see the button.
const canShareFiles = typeof navigator.canShare === 'function'
  && navigator.canShare({ files: [new File([''], 'probe.pdf', { type: 'application/pdf' })] });

// Browsers only open the share sheet straight after a click. A long document
// can outlast that window while it is written, so the finished file is kept
// and the next click shares it instantly. Any edit throws it away.
let readyToShare = null;
on('pages', () => { readyToShare = null; });

async function sharePdf() {
  if (!readyToShare) {
    const name = `${safeName(state.outName) || 'document'}-edited.pdf`;
    await withBusy('Writing PDF…', async (ui) => {
      const bytes = await assemble(state.pages, (done, total) => {
        ui.label(`Writing page ${done} of ${total}…`);
        ui.step(done, total);
      });
      readyToShare = new File([bytes], name, { type: 'application/pdf' });
    });
    if (!readyToShare) return;
  }
  try {
    await navigator.share({ files: [readyToShare] });
  } catch (err) {
    if (err.name === 'AbortError') return;   // closed the sheet
    if (err.name === 'NotAllowedError') {
      toast('Your PDF is ready. Click Share again to send it.', 'ok');
      return;
    }
    toast(`Could not share: ${err.message}`, 'err');
  }
}

$('#btnShare').onclick = sharePdf;

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
  // The viewer and the signature dialog handle their own keys while open.
  if (typing || !$('#viewer').hidden || !$('#signDialog').hidden) return;
  if (historyKey(e)) return;
  if (!state.pages.length) return;
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
    deleteWithUndo(targetPages());
  }
});

/* ───────────────────────── go ───────────────────────── */

on('pages', syncChrome);
on('sources', syncChrome);

initViewer();
initHistory();
initIntake();
initOrganize();
initCompress();
initWatermark();
initSign();
initNotes();
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
