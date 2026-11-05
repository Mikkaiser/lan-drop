// LAN Drop Local, page side: talks to the LAN Drop Local program on the host computer over
// plain HTTP (uploads, downloads) and Server-Sent Events (live file list, addresses, people).

const $ = s => document.querySelector(s);
const IMG = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
const fileUrl = name => 'files/' + encodeURIComponent(name);

function fmtSize(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i ? b.toFixed(b < 10 ? 1 : 0) : b) + ' ' + u[i];
}
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(t).toLocaleDateString();
}
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids); return e;
}

// ---------- file list ----------

let files = [], known = null;
function render() {
  const q = $('#search').value.trim().toLowerCase();
  const list = q ? files.filter(f => f.name.toLowerCase().includes(q)) : files;
  const total = files.reduce((n, f) => n + f.size, 0);
  $('#summary').textContent = files.length ? ` · ${files.length} file${files.length > 1 ? 's' : ''}, ${fmtSize(total)}` : '';
  const ul = $('#files');
  if (!list.length) {
    ul.replaceChildren(el('li', { className: 'empty', textContent: files.length ? 'No matches.' : 'Nothing shared yet. Drop something above.' }));
  } else {
    ul.replaceChildren(...list.map(f => {
      const ext = (f.name.match(/\.([^.]+)$/) || [, ''])[1].slice(0, 4) || 'file';
      const thumb = el('div', { className: 'thumb' });
      if (IMG.test(f.name)) thumb.append(el('img', { src: fileUrl(f.name) + '?v=' + f.mtime, loading: 'lazy', alt: '' }));
      else thumb.textContent = ext;
      const del = el('button', { className: 'btn del', textContent: 'Delete', title: 'Delete for everyone' });
      del.onclick = async () => {
        if (!confirm(`Delete "${f.name}" for everyone?`)) return;
        const r = await fetch(fileUrl(f.name), { method: 'DELETE' }).catch(() => null);
        if (!r || !r.ok) toast('Delete failed');
      };
      const li = el('li', {},
        thumb,
        el('div', { className: 'meta' },
          el('a', { href: fileUrl(f.name), target: '_blank', textContent: f.name, title: f.name }),
          el('small', { textContent: `${fmtSize(f.size)} · ${ago(f.mtime)}` })),
        el('div', { className: 'actions' },
          el('a', { className: 'btn', href: fileUrl(f.name) + '?dl=1', textContent: 'Download' }),
          del));
      if (known && !known.has(f.name)) li.classList.add('new');
      return li;
    }));
  }
  known = new Set(files.map(f => f.name));
}
$('#search').oninput = render;
setInterval(render, 30000);

// ---------- live updates ----------

let info = null, offlineTimer = null;
function connect() {
  const es = new EventSource('events');
  es.addEventListener('open', () => {
    clearTimeout(offlineTimer); $('#offline').hidden = true;
    $('#dot').className = 'dot on';
  });
  es.onerror = () => {
    $('#dot').className = 'dot'; $('#status').textContent = 'Reconnecting…';
    clearTimeout(offlineTimer);
    offlineTimer = setTimeout(() => { $('#offline').hidden = false; }, 5000);
  };
  es.addEventListener('files', e => { files = JSON.parse(e.data); render(); });
  es.addEventListener('info', e => showInfo(JSON.parse(e.data)));
  es.addEventListener('people', e => showPeople(JSON.parse(e.data)));
}
connect();

let shownUrl = '';
function showInfo(i) {
  info = i;
  $('#status').textContent = i.host ? 'Sharing from this computer' : `Connected to ${i.hostname}`;
  $('#footHost').textContent = `LAN Drop Local ${i.version} · ${i.hostname}`;
  $('#hostPanel').hidden = !i.host;
  if (!i.host) return;
  $('#folder').textContent = i.folder || '';
  const box = $('#urls');
  box.replaceChildren(...(i.urls.length ? i.urls.map(u => el('a', { href: u, textContent: u.replace('http://', ''), title: 'Click to copy' }))
    : [el('span', { className: 'muted', textContent: 'Not connected to a network yet. Plug in a cable or join a Wi-Fi.' })]));
  for (const a of box.querySelectorAll('a')) a.onclick = e => {
    e.preventDefault();
    navigator.clipboard?.writeText(a.href).then(() => toast('Address copied'), () => toast(a.href));
  };
  // QR code of the first address, for phones.
  const first = i.urls[0] || '';
  if (first !== shownUrl) {
    shownUrl = first;
    if (first && window.qrcode) {
      const qr = qrcode(0, 'M'); qr.addData(first); qr.make();
      $('#qr').replaceChildren(el('img', { src: qr.createDataURL(6, 0), alt: 'QR code for ' + first }));
      $('#qr').hidden = false;
    } else $('#qr').hidden = true;
  }
}

function showPeople(people) {
  $('#peopleLabel').textContent = people.length ? `${people.length} ${people.length > 1 ? 'people' : 'person'} connected` : 'Nobody connected yet';
  $('#people').replaceChildren(...people.map(p => el('li', {}, el('span', { textContent: p.device }), el('code', { textContent: p.ip }))));
}

$('#folderBtn').onclick = async () => {
  toast('Choose the folder in the window that opened…');
  const r = await fetch('api/folder', { method: 'POST' }).then(r => r.json()).catch(() => null);
  if (r?.changed) toast('Now sharing ' + r.folder);
};

// ---------- uploads (a few at a time, straight into the host's folder) ----------

function transferRow(label, size) {
  const pct = el('span', { className: 'pct', textContent: 'waiting' });
  const bar = el('i');
  const row = el('div', { className: 'up' },
    el('div', { className: 'line' }, el('span', { className: 'name', textContent: `${label} (${fmtSize(size)})` }), pct),
    el('div', { className: 'bar' }, bar));
  $('#transfers').append(row);
  let started = 0;
  return {
    progress(bytes) {
      const now = performance.now(); if (!started) started = now;
      const p = size ? Math.min(100, Math.round(bytes / size * 100)) : 100;
      bar.style.width = p + '%';
      const secs = (now - started) / 1000;
      pct.textContent = secs > 1 ? `${p}% · ${fmtSize(Math.round(bytes / secs))}/s` : p + '%';
    },
    done(text = 'done') { row.classList.add('done'); pct.textContent = text; setTimeout(() => row.remove(), 1500); },
    fail(msg) { row.classList.add('err'); pct.textContent = 'failed: ' + msg; setTimeout(() => row.remove(), 6000); },
  };
}

const queue = []; let active = 0; const MAX_PARALLEL = 3;
function enqueue(list) {
  for (const f of list) queue.push({ f, ui: transferRow('↑ ' + f.name, f.size) });
  pump();
}
function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    active++;
    upload(queue.shift()).finally(() => { active--; pump(); });
  }
}
function upload({ f, ui }) {
  return new Promise(resolve => {
    const x = new XMLHttpRequest();
    x.open('POST', 'upload');
    x.setRequestHeader('X-Filename', encodeURIComponent(f.name));
    x.upload.onprogress = e => { if (e.lengthComputable) ui.progress(e.loaded); };
    x.onload = () => {
      if (x.status === 201) {
        const saved = JSON.parse(x.responseText).name;
        ui.done(saved === f.name ? 'done' : 'saved as ' + saved);
      } else ui.fail(x.responseText || x.status);
      resolve();
    };
    x.onerror = () => { ui.fail('network error'); resolve(); };
    x.send(f);
  });
}

// ---------- drag & drop / pick / paste ----------

let depth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; document.body.classList.add('dragging'); });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
  const picked = []; let folders = 0;
  for (const item of e.dataTransfer.items) {
    if (item.kind !== 'file') continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) { folders++; continue; }
    const f = item.getAsFile(); if (f) picked.push(f);
  }
  if (folders) toast(`Skipped ${folders} folder${folders > 1 ? 's' : ''}. Zip it first to share a folder.`);
  enqueue(picked);
});
const picker = $('#picker');
$('#drop').onclick = () => picker.click();
$('#drop').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } };
picker.onchange = () => { enqueue([...picker.files]); picker.value = ''; };
addEventListener('paste', e => {
  if (e.target === $('#search')) return;
  const pasted = [...(e.clipboardData?.files || [])].map((f, i) =>
    f.name === 'image.png' ? new File([f], `pasted-${new Date().toISOString().replace(/[:.]/g, '-')}${i ? '-' + i : ''}.png`, { type: f.type }) : f);
  if (pasted.length) enqueue(pasted);
});
