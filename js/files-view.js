// The file view host and guests share: status line, notices, the file list, transfer progress
// rows, the upload queue, and drag & drop / pick / paste.
//
// What "open", "upload" and "delete" do depends on the role, so host.js and guest.js each
// call setBackend() with their own:
//   { openLabel, open(file, progressRow), upload(file, progressRow), remove(name) }

import { MAX_PARALLEL_UPLOADS } from './config.js';
import { $, el, extensionLabel, formatSize, timeAgo, toast } from './util.js';

let backend = null;
let files = [];
let knownNames = null; // to flash rows that just appeared

export function setBackend(b) { backend = b; }

export function showApp() {
  $('#startScreen').hidden = true;
  $('#appScreen').hidden = false;
  renderFiles();
}

// ---------- Status and notices ----------

export function setStatus(text, live) {
  $('#status').textContent = text;
  $('#dot').className = live ? 'dot on' : 'dot';
}
/** The page's main notice; '' hides it. */
export function setNotice(text) {
  $('#notice').textContent = text || '';
  $('#notice').hidden = !text;
}

// ---------- File list ----------

export function setFiles(list) { files = list; renderFiles(); }

function fileRow(file) {
  const open = el('button', { className: 'btn', textContent: backend.openLabel });
  open.onclick = () => backend.open(file, progressRow('↓ ' + file.name, file.size));
  const remove = el('button', { className: 'btn del', textContent: 'Delete', title: 'Delete for everyone' });
  remove.onclick = () => { if (confirm(`Delete "${file.name}" for everyone?`)) backend.remove(file.name); };
  const row = el('li', {},
    el('div', { className: 'thumb', textContent: extensionLabel(file.name) }),
    el('div', { className: 'meta' },
      el('b', { textContent: file.name, title: file.name }),
      el('small', { textContent: `${formatSize(file.size)} · ${timeAgo(file.mtime)}` })),
    el('div', { className: 'actions' }, open, remove));
  if (knownNames && !knownNames.has(file.name)) row.classList.add('new');
  return row;
}

function renderFiles() {
  const query = $('#search').value.trim().toLowerCase();
  const shown = query ? files.filter(f => f.name.toLowerCase().includes(query)) : files;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  $('#summary').textContent = files.length
    ? ` · ${files.length} file${files.length > 1 ? 's' : ''}, ${formatSize(total)}` : '';
  const list = $('#files');
  if (shown.length) list.replaceChildren(...shown.map(fileRow));
  else list.replaceChildren(el('li', { className: 'empty', textContent: files.length ? 'No matches.' : 'Nothing shared yet. Drop something above.' }));
  knownNames = new Set(files.map(f => f.name));
}

$('#search').oninput = renderFiles;
setInterval(() => backend && renderFiles(), 30000); // keeps "5 min ago" current

// ---------- Progress rows ----------

/**
 * A row in the transfers list. Returns:
 *   progress(bytesSoFar)   bar, percent and average speed
 *   note(text)             replace the percent with a word ("saving…")
 *   done(text?)            green, then removed
 *   fail(message)          red, then removed
 */
export function progressRow(label, size) {
  const status = el('span', { className: 'pct', textContent: 'waiting' });
  const bar = el('i');
  const row = el('div', { className: 'up' },
    el('div', { className: 'line' }, el('span', { className: 'name', textContent: `${label} (${formatSize(size)})` }), status),
    el('div', { className: 'bar' }, bar));
  $('#transfers').append(row);

  let finished = false, startedAt = 0, lastBytes = 0;
  const seconds = () => (performance.now() - startedAt) / 1000;
  return {
    progress(bytes) {
      if (!startedAt) startedAt = performance.now();
      const percent = size ? Math.min(100, Math.round(bytes / size * 100)) : 100;
      bar.style.width = percent + '%';
      lastBytes = bytes;
      status.textContent = seconds() > 1 ? `${percent}% · ${formatSize(Math.round(bytes / seconds()))}/s` : percent + '%';
    },
    note(text) { status.textContent = text; },
    done(text = 'done') {
      if (finished) return;
      finished = true;
      if (text === 'done' && startedAt && seconds() > 1) text = `done · ${formatSize(Math.round(lastBytes / seconds()))}/s`;
      row.classList.add('done');
      status.textContent = text;
      setTimeout(() => row.remove(), 1500);
    },
    fail(message) {
      if (finished) return;
      finished = true;
      row.classList.add('err');
      status.textContent = 'failed: ' + message;
      setTimeout(() => row.remove(), 6000);
    },
  };
}

// ---------- Upload queue ----------

const waiting = [];
let uploading = 0;

export function queueUploads(fileList) {
  for (const file of fileList) waiting.push({ file, row: progressRow('↑ ' + file.name, file.size) });
  startUploads();
}
function startUploads() {
  while (uploading < MAX_PARALLEL_UPLOADS && waiting.length) {
    const { file, row } = waiting.shift();
    uploading++;
    backend.upload(file, row)
      .catch(e => row.fail(e.message || String(e)))
      .finally(() => { uploading--; startUploads(); });
  }
}

// ---------- Drag & drop, pick, paste ----------

let dragDepth = 0;
const carriesFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
const inFileView = () => backend && !$('#appScreen').hidden;

addEventListener('dragenter', e => {
  if (!carriesFiles(e) || !inFileView()) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
addEventListener('dragover', e => { if (carriesFiles(e)) e.preventDefault(); });
addEventListener('dragleave', e => {
  if (!carriesFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
});
addEventListener('drop', e => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (!inFileView()) return;
  const dropped = [];
  let folders = 0;
  for (const item of e.dataTransfer.items) {
    if (item.kind !== 'file') continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) { folders++; continue; }
    const file = item.getAsFile();
    if (file) dropped.push(file);
  }
  if (folders) toast(`Skipped ${folders} folder${folders > 1 ? 's' : ''}. Zip it first to share a folder.`);
  queueUploads(dropped);
});

const picker = $('#picker');
$('#drop').onclick = () => picker.click();
$('#drop').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } };
picker.onchange = () => { queueUploads([...picker.files]); picker.value = ''; };

addEventListener('paste', e => {
  if (!inFileView() || e.target === $('#search')) return;
  // Pasted screenshots all arrive as "image.png"; give each a unique name.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pasted = [...(e.clipboardData?.files || [])].map((file, i) =>
    file.name === 'image.png' ? new File([file], `pasted-${stamp}${i ? '-' + i : ''}.png`, { type: file.type }) : file);
  if (pasted.length) queueUploads(pasted);
});
