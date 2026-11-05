// LAN Drop Local, page side. Talks to the LAN Drop Local program on the host computer
// (server.js) over plain HTTP:
//   GET /events          live updates (Server-Sent Events): info, files, people
//   POST /upload         one file per request, name in the X-Filename header
//   GET / DELETE /files/<name>
//   POST /api/folder     host only: choose a different folder
//
// Sections: helpers · live updates · host panel · file list · uploads · drag & drop, pick, paste

const MAX_PARALLEL_UPLOADS = 3;
const SHOW_OFFLINE_AFTER_MS = 5000; // a short blip shouldn't flash the "lost connection" notice
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

// ---------- Helpers ----------

const $ = selector => document.querySelector(selector);

/** Create an element with properties and children: el('li', { className: 'x' }, 'text', child). */
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const fileUrl = name => 'files/' + encodeURIComponent(name);

/** 1536 -> "1.5 KB" */
function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return (i ? bytes.toFixed(bytes < 10 ? 1 : 0) : bytes) + ' ' + units[i];
}

/** A timestamp as "just now", "5 min ago", "3 h ago" or a date. */
function timeAgo(ms) {
  const seconds = (Date.now() - ms) / 1000;
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
  if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago';
  return new Date(ms).toLocaleDateString();
}

let toastTimer;
/** A short message at the bottom of the page. */
function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 2800);
}

// ---------- Live updates from the host ----------

let offlineTimer = null;

function connect() {
  // EventSource reconnects by itself; we only show what's going on.
  const events = new EventSource('events');
  events.addEventListener('open', () => {
    clearTimeout(offlineTimer);
    $('#offline').hidden = true;
    $('#dot').className = 'dot on';
  });
  events.onerror = () => {
    $('#dot').className = 'dot';
    $('#status').textContent = 'Reconnecting…';
    clearTimeout(offlineTimer);
    offlineTimer = setTimeout(() => { $('#offline').hidden = false; }, SHOW_OFFLINE_AFTER_MS);
  };
  events.addEventListener('info', e => showInfo(JSON.parse(e.data)));
  events.addEventListener('files', e => setFiles(JSON.parse(e.data)));
  events.addEventListener('people', e => showPeople(JSON.parse(e.data))); // only sent to the host
}

// ---------- Host panel: addresses, QR code, folder, people ----------

let qrFor = ''; // the address the QR code currently shows

/** info: { version, hostname, urls, host, folder? }. The host panel shows only on the host computer. */
function showInfo(info) {
  $('#status').textContent = info.host ? 'Sharing from this computer' : `Connected to ${info.hostname}`;
  $('#footHost').textContent = `LAN Drop Local ${info.version} · ${info.hostname}`;
  $('#hostPanel').hidden = !info.host;
  if (!info.host) return;

  $('#folder').textContent = info.folder || '';
  showAddresses(info.urls);
  showQrCode(info.urls[0] || '');
}

/** The addresses others can open; clicking one copies it. */
function showAddresses(urls) {
  const box = $('#urls');
  if (!urls.length) {
    box.replaceChildren(el('span', { className: 'muted', textContent: 'Not connected to a network yet. Plug in a cable or join a Wi-Fi.' }));
    return;
  }
  box.replaceChildren(...urls.map(url => {
    const link = el('a', { href: url, textContent: url.replace('http://', ''), title: 'Click to copy' });
    link.onclick = e => {
      e.preventDefault();
      navigator.clipboard?.writeText(url).then(() => toast('Address copied'), () => toast(url));
    };
    return link;
  }));
}

/** A QR code of the first address, for phones. */
function showQrCode(url) {
  if (url === qrFor) return;
  qrFor = url;
  const box = $('#qr');
  box.hidden = !url || !window.qrcode;
  if (box.hidden) return;
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  box.replaceChildren(el('img', { src: qr.createDataURL(6, 0), alt: 'QR code for ' + url }));
}

/** people: [{ device, ip, since }] */
function showPeople(people) {
  const n = people.length;
  $('#peopleLabel').textContent = n ? `${n} ${n > 1 ? 'people' : 'person'} connected` : 'Nobody connected yet';
  $('#people').replaceChildren(...people.map(person =>
    el('li', {}, el('span', { textContent: person.device }), el('code', { textContent: person.ip }))));
}

$('#folderBtn').onclick = async () => {
  toast('Choose the folder in the window that opened…');
  const result = await fetch('api/folder', { method: 'POST' }).then(r => r.json()).catch(() => null);
  if (result?.changed) toast('Now sharing ' + result.folder);
};

// ---------- File list ----------

let files = [];        // [{ name, size, mtime }], newest first
let knownNames = null; // to flash rows that just appeared

function setFiles(list) {
  files = list;
  renderFiles();
}

async function deleteFile(file) {
  if (!confirm(`Delete "${file.name}" for everyone?`)) return;
  const res = await fetch(fileUrl(file.name), { method: 'DELETE' }).catch(() => null);
  if (!res || !res.ok) toast('Delete failed');
  // No need to update the list here: the host announces the change to everyone.
}

function fileRow(file) {
  const url = fileUrl(file.name);
  const thumb = el('div', { className: 'thumb' });
  if (IMAGE_FILE.test(file.name)) thumb.append(el('img', { src: url + '?v=' + file.mtime, loading: 'lazy', alt: '' }));
  else thumb.textContent = (file.name.match(/\.([^.]+)$/) || [, ''])[1].slice(0, 4) || 'file';

  const remove = el('button', { className: 'btn del', textContent: 'Delete', title: 'Delete for everyone' });
  remove.onclick = () => deleteFile(file);

  const row = el('li', {},
    thumb,
    el('div', { className: 'meta' },
      el('a', { href: url, target: '_blank', textContent: file.name, title: file.name }), // opens in the browser if it can
      el('small', { textContent: `${formatSize(file.size)} · ${timeAgo(file.mtime)}` })),
    el('div', { className: 'actions' },
      el('a', { className: 'btn', href: url + '?dl=1', textContent: 'Download' }),
      remove));
  if (knownNames && !knownNames.has(file.name)) row.classList.add('new');
  return row;
}

function renderFiles() {
  const query = $('#search').value.trim().toLowerCase();
  const shown = query ? files.filter(f => f.name.toLowerCase().includes(query)) : files;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  $('#summary').textContent = files.length ? ` · ${files.length} file${files.length > 1 ? 's' : ''}, ${formatSize(total)}` : '';

  const list = $('#files');
  if (shown.length) list.replaceChildren(...shown.map(fileRow));
  else list.replaceChildren(el('li', { className: 'empty', textContent: files.length ? 'No matches.' : 'Nothing shared yet. Drop something above.' }));
  knownNames = new Set(files.map(f => f.name));
}

$('#search').oninput = renderFiles;
setInterval(renderFiles, 30000); // keeps "5 min ago" current

// ---------- Uploads: a few at a time, straight into the host's folder ----------

/** A row in the uploads list: progress(bytes), done(text?), fail(message). */
function progressRow(label, size) {
  const status = el('span', { className: 'pct', textContent: 'waiting' });
  const bar = el('i');
  const row = el('div', { className: 'up' },
    el('div', { className: 'line' }, el('span', { className: 'name', textContent: `${label} (${formatSize(size)})` }), status),
    el('div', { className: 'bar' }, bar));
  $('#transfers').append(row);

  let startedAt = 0;
  return {
    progress(bytes) {
      const now = performance.now();
      if (!startedAt) startedAt = now;
      const percent = size ? Math.min(100, Math.round(bytes / size * 100)) : 100;
      const seconds = (now - startedAt) / 1000;
      bar.style.width = percent + '%';
      status.textContent = seconds > 1 ? `${percent}% · ${formatSize(Math.round(bytes / seconds))}/s` : percent + '%';
    },
    done(text = 'done') {
      row.classList.add('done');
      status.textContent = text;
      setTimeout(() => row.remove(), 1500);
    },
    fail(message) {
      row.classList.add('err');
      status.textContent = 'failed: ' + message;
      setTimeout(() => row.remove(), 6000);
    },
  };
}

const waiting = [];
let uploading = 0;

function queueUploads(fileList) {
  for (const file of fileList) waiting.push({ file, row: progressRow('↑ ' + file.name, file.size) });
  startUploads();
}

function startUploads() {
  while (uploading < MAX_PARALLEL_UPLOADS && waiting.length) {
    uploading++;
    upload(waiting.shift()).finally(() => { uploading--; startUploads(); });
  }
}

/** XMLHttpRequest rather than fetch, because only it reports upload progress. Never rejects. */
function upload({ file, row }) {
  return new Promise(resolve => {
    const request = new XMLHttpRequest();
    request.open('POST', 'upload');
    request.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    request.upload.onprogress = e => { if (e.lengthComputable) row.progress(e.loaded); };
    request.onload = () => {
      if (request.status === 201) {
        const savedAs = JSON.parse(request.responseText).name; // renamed if the name was taken
        row.done(savedAs === file.name ? 'done' : 'saved as ' + savedAs);
      } else {
        row.fail(request.responseText || request.status);
      }
      resolve();
    };
    request.onerror = () => { row.fail('network error'); resolve(); };
    request.send(file);
  });
}

// ---------- Drag & drop, pick, paste ----------

let dragDepth = 0; // dragenter/dragleave fire for every child element; count them
const carriesFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');

addEventListener('dragenter', e => {
  if (!carriesFiles(e)) return;
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
  if (e.target === $('#search')) return;
  // Pasted screenshots all arrive as "image.png"; give each a unique name.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pasted = [...(e.clipboardData?.files || [])].map((file, i) =>
    file.name === 'image.png' ? new File([file], `pasted-${stamp}${i ? '-' + i : ''}.png`, { type: file.type }) : file);
  if (pasted.length) queueUploads(pasted);
});

// ---------- Start ----------

connect();
