// LAN Drop (web) — share a folder on this computer with anyone who has the link.
// The host's browser reads/writes the folder via the File System Access API.
// Files travel device-to-device over WebRTC; the public PeerJS broker only introduces peers.

const $ = s => document.querySelector(s);
const PREFIX = 'landrop-';            // keeps our ids apart from other apps on the public broker
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CHUNK = 64 * 1024;              // per WebRTC message
const BLOCK = 1024 * 1024;            // per disk read
const HIGH_WATER = 4 * 1024 * 1024;   // pause sending above this much buffered data
const BIG_DOWNLOAD = 200 * 1024 * 1024; // above this, stream to disk instead of memory (if supported)

// ---------- small helpers ----------

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
function newCode() {
  return [...crypto.getRandomValues(new Uint8Array(6))].map(x => ALPHABET[x % ALPHABET.length]).join('');
}
function shareLink(code) { return location.origin + location.pathname + '#' + code; }

function safeName(raw) {
  let name = String(raw).split(/[\\/]/).pop()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 200);
  if (!name) name = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = '_' + name;
  return name;
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  el('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Binary messages carry a 4-byte transfer id so several transfers can share one connection.
function frame(id, bytes) {
  const out = new Uint8Array(4 + bytes.byteLength);
  new DataView(out.buffer).setUint32(0, id);
  out.set(bytes, 4);
  return out.buffer;
}
function unframe(buf) { return [new DataView(buf).getUint32(0), new Uint8Array(buf, 4)]; }

function sendJSON(dc, msg) { if (dc && dc.readyState === 'open') dc.send(JSON.stringify(msg)); }

// Wait until the channel has room, so big files don't pile up in memory.
function drain(dc) {
  if (dc.bufferedAmount < HIGH_WATER || dc.readyState !== 'open') return Promise.resolve();
  dc.bufferedAmountLowThreshold = HIGH_WATER / 2;
  return new Promise(resolve => {
    const done = () => { dc.removeEventListener('bufferedamountlow', done); dc.removeEventListener('close', done); resolve(); };
    dc.addEventListener('bufferedamountlow', done);
    dc.addEventListener('close', done);
  });
}

// Send a Blob/File as framed chunks; calls onProgress(bytesSent). Returns false if the channel closed.
async function sendBlob(dc, id, blob, isCancelled = () => false, onProgress = () => {}) {
  for (let off = 0; off < blob.size; off += BLOCK) {
    const bytes = new Uint8Array(await blob.slice(off, off + BLOCK).arrayBuffer());
    for (let i = 0; i < bytes.length; i += CHUNK) {
      await drain(dc);
      if (dc.readyState !== 'open' || isCancelled()) return false;
      dc.send(frame(id, bytes.subarray(i, i + CHUNK)));
    }
    onProgress(Math.min(off + BLOCK, blob.size));
  }
  return true;
}

// Tiny IndexedDB key-value store, used to remember the host's folder between visits.
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('landrop', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const saveDirHandle = h => idb('readwrite', s => s.put(h, 'dir')).catch(() => {});
const loadDirHandle = () => idb('readonly', s => s.get('dir')).catch(() => null);
const clearDirHandle = () => idb('readwrite', s => s.delete('dir')).catch(() => {});
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- shared UI (host and guests see the same file view) ----------

let backend = null;   // { upload(file, ui), open(file, ui), remove(name), openLabel }
let files = [], known = null;

function setStatus(text, live) {
  $('#status').textContent = text;
  $('#dot').className = live ? 'dot on' : 'dot';
}
function setNotice(text) { $('#notice').textContent = text || ''; $('#notice').hidden = !text; }

function setFiles(list) { files = list; render(); }

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
      const open = el('button', { className: 'btn', textContent: backend.openLabel });
      open.onclick = () => backend.open(f, transferRow('↓ ' + f.name, f.size));
      const del = el('button', { className: 'btn del', textContent: 'Delete', title: 'Delete for everyone' });
      del.onclick = () => { if (confirm(`Delete "${f.name}" for everyone?`)) backend.remove(f.name); };
      const li = el('li', {},
        el('div', { className: 'thumb', textContent: ext }),
        el('div', { className: 'meta' },
          el('b', { textContent: f.name, title: f.name }),
          el('small', { textContent: `${fmtSize(f.size)} · ${ago(f.mtime)}` })),
        el('div', { className: 'actions' }, open, del));
      if (known && !known.has(f.name)) li.classList.add('new');
      return li;
    }));
  }
  known = new Set(files.map(f => f.name));
}
$('#search').oninput = render;
setInterval(() => backend && render(), 30000);

// A progress row in the transfers list.
function transferRow(label, size) {
  const pct = el('span', { className: 'pct', textContent: 'waiting' });
  const bar = el('i');
  const row = el('div', { className: 'up' },
    el('div', { className: 'line' }, el('span', { className: 'name', textContent: `${label} (${fmtSize(size)})` }), pct),
    el('div', { className: 'bar' }, bar));
  $('#transfers').append(row);
  let finished = false;
  return {
    progress(bytes) {
      const p = size ? Math.min(100, Math.round(bytes / size * 100)) : 100;
      bar.style.width = p + '%'; pct.textContent = p + '%';
    },
    note(text) { pct.textContent = text; },
    done(text = 'done') {
      if (finished) return; finished = true;
      row.classList.add('done'); pct.textContent = text; setTimeout(() => row.remove(), 1500);
    },
    fail(msg) {
      if (finished) return; finished = true;
      row.classList.add('err'); pct.textContent = 'failed: ' + msg; setTimeout(() => row.remove(), 6000);
    },
  };
}

// Upload queue: a few at a time.
const queue = []; let active = 0; const MAX_PARALLEL = 3;
function enqueue(list) {
  for (const f of list) queue.push({ f, ui: transferRow('↑ ' + f.name, f.size) });
  pump();
}
function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const { f, ui } = queue.shift();
    active++;
    backend.upload(f, ui).catch(e => ui.fail(e.message || String(e))).finally(() => { active--; pump(); });
  }
}

// Drag & drop / pick / paste
let depth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
const inApp = () => backend && !$('#appScreen').hidden;
addEventListener('dragenter', e => { if (!hasFiles(e) || !inApp()) return; e.preventDefault(); depth++; document.body.classList.add('dragging'); });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
  if (!inApp()) return;
  const picked = []; let folders = 0;
  for (const item of e.dataTransfer.items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) { folders++; continue; }
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
  if (!inApp() || e.target === $('#search')) return;
  const pasted = [...(e.clipboardData?.files || [])].map((f, i) =>
    f.name === 'image.png' ? new File([f], `pasted-${new Date().toISOString().replace(/[:.]/g, '-')}${i ? '-' + i : ''}.png`, { type: f.type }) : f);
  if (pasted.length) enqueue(pasted);
});

function showApp() {
  $('#startScreen').hidden = true;
  $('#appScreen').hidden = false;
  render();
}

// ---------- HOST: owns the folder, serves it to guests ----------

const host = { dir: null, code: null, peer: null, guests: new Set(), incoming: new Set(), key: '', scanning: false, retries: 0 };

async function listDir() {
  const out = [];
  for await (const [name, h] of host.dir.entries()) {
    if (h.kind !== 'file' || name.startsWith('.') || name.endsWith('.crswap') || host.incoming.has(name)) continue;
    try { const f = await h.getFile(); out.push({ name, size: f.size, mtime: f.lastModified }); } catch { /* vanished */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Re-read the folder and tell everyone if anything changed (also catches edits made in Explorer).
async function rescan() {
  if (host.scanning || !host.dir) return;
  host.scanning = true;
  try {
    const list = await listDir();
    const key = JSON.stringify(list);
    if (key !== host.key) {
      host.key = key;
      setFiles(list);
      for (const c of host.guests) sendJSON(c.dataChannel, { t: 'files', files: list });
    }
  } catch (e) {
    setNotice('Lost access to the folder (' + e.message + '). Click "Stop sharing" and choose it again.');
  } finally { host.scanning = false; }
}

async function fileExists(name) {
  try { await host.dir.getFileHandle(name); return true; } catch { return false; }
}
async function uniqueName(name) {
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let candidate = name;
  for (let i = 1; host.incoming.has(candidate) || await fileExists(candidate); i++) candidate = `${base} (${i})${ext}`;
  return candidate;
}

// Start writing a new file into the shared folder. It stays hidden from the list until finished.
async function openIncoming(rawName) {
  const name = await uniqueName(safeName(rawName));
  host.incoming.add(name);
  try {
    const handle = await host.dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    return {
      name, writable,
      async finish(ok) {
        try { ok ? await writable.close() : await writable.abort(); }
        finally {
          host.incoming.delete(name);
          if (!ok) await host.dir.removeEntry(name).catch(() => {});
          rescan();
        }
      },
    };
  } catch (e) {
    host.incoming.delete(name);
    throw e;
  }
}

function hostKnows(name) { try { return JSON.parse(host.key).some(f => f.name === name); } catch { return false; } }

function acceptGuest(conn) {
  const gets = new Map(), puts = new Map();

  conn.on('open', () => {
    host.guests.add(conn);
    updateGuestCount();
    sendJSON(conn.dataChannel, { t: 'files', files });
  });

  conn.on('data', async d => {
    const dc = conn.dataChannel;
    if (typeof d !== 'string') {
      const [id, bytes] = unframe(d);
      const p = puts.get(id); if (!p) return;
      p.got += bytes.byteLength;
      p.queue = p.queue.then(() => p.inc.writable.write(bytes));
      if (p.got >= p.size) finishPut(id, p);
      return;
    }
    let m; try { m = JSON.parse(d); } catch { return; }

    if (m.t === 'get') {
      let cancelled = false;
      gets.set(m.id, () => { cancelled = true; });
      try {
        if (!hostKnows(m.name)) throw new Error('file not found');
        const file = await (await host.dir.getFileHandle(m.name)).getFile();
        sendJSON(dc, { t: 'meta', id: m.id, size: file.size });
        if (await sendBlob(dc, m.id, file, () => cancelled)) sendJSON(dc, { t: 'end', id: m.id });
      } catch (e) { sendJSON(dc, { t: 'err', id: m.id, msg: e.message }); }
      finally { gets.delete(m.id); }
    } else if (m.t === 'put') {
      try {
        const inc = await openIncoming(m.name);
        const p = { inc, size: Number(m.size) || 0, got: 0, queue: Promise.resolve() };
        puts.set(m.id, p);
        if (p.size === 0) finishPut(m.id, p);
        else sendJSON(dc, { t: 'ready', id: m.id });
      } catch (e) { sendJSON(dc, { t: 'err', id: m.id, msg: e.message }); }
    } else if (m.t === 'del') {
      if (hostKnows(m.name)) await host.dir.removeEntry(m.name).catch(() => {});
      rescan();
    } else if (m.t === 'cancel') {
      gets.get(m.id)?.();
      const p = puts.get(m.id);
      if (p) { puts.delete(m.id); p.queue.finally(() => p.inc.finish(false)); }
    }
  });

  function finishPut(id, p) {
    puts.delete(id);
    p.queue
      .then(() => p.inc.finish(true))
      .then(() => sendJSON(conn.dataChannel, { t: 'saved', id, name: p.inc.name }),
            e => { p.inc.finish(false).catch(() => {}); sendJSON(conn.dataChannel, { t: 'err', id, msg: e.message }); });
  }

  conn.on('close', () => {
    host.guests.delete(conn);
    for (const cancel of gets.values()) cancel();
    for (const p of puts.values()) p.queue.finally(() => p.inc.finish(false));
    puts.clear();
    updateGuestCount();
  });
}

function updateGuestCount() {
  if (!host.peer || host.peer.disconnected) return;
  const n = host.guests.size;
  setStatus(n ? `Sharing · ${n} device${n > 1 ? 's' : ''} connected` : 'Sharing · waiting for others to join', true);
}

function showHostCode() {
  const link = shareLink(host.code);
  $('#hostCode').textContent = host.code;
  $('#hostLink').textContent = link; $('#hostLink').href = link;
  if (window.qrcode) {
    const qr = qrcode(0, 'M'); qr.addData(link); qr.make();
    $('#qr').replaceChildren(el('img', { src: qr.createDataURL(6, 0), alt: 'QR code for the share link' }));
  }
}

function openHostPeer() {
  const peer = host.peer = new Peer(PREFIX + host.code);
  setStatus('Connecting to the broker…', false);
  peer.on('open', () => { host.retries = 0; setNotice(''); updateGuestCount(); });
  peer.on('connection', acceptGuest);
  peer.on('disconnected', () => {
    // Network changed or dropped: keep the same code and reconnect.
    setStatus('Offline · reconnecting…', false);
    setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 3000);
  });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') {
      // Usually our own previous session still being released; retry a few times before giving up the code.
      peer.destroy();
      if (++host.retries > 3) { host.code = newCode(); store.set('landrop-code', host.code); host.retries = 0; showHostCode(); toast('That code was taken, so you have a new one.'); }
      setTimeout(openHostPeer, 3000);
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
      setStatus('Offline · reconnecting…', false);
      setTimeout(() => { if (peer.destroyed) return; peer.disconnected ? peer.reconnect() : null; }, 5000);
    } else {
      console.warn('peer error', e.type, e);
    }
  });
}

async function startHosting(dir) {
  host.dir = dir;
  host.code = store.get('landrop-code') || newCode();
  store.set('landrop-code', host.code);
  saveDirHandle(dir);

  backend = {
    openLabel: 'Open',
    async upload(file, ui) {
      const inc = await openIncoming(file.name);
      try {
        for (let off = 0; off < file.size; off += BLOCK) {
          await inc.writable.write(file.slice(off, off + BLOCK));
          ui.progress(Math.min(off + BLOCK, file.size));
        }
        await inc.finish(true);
        ui.done(inc.name === safeName(file.name) ? 'done' : 'saved as ' + inc.name);
      } catch (e) { await inc.finish(false).catch(() => {}); throw e; }
    },
    async open(f, ui) {
      const file = await (await host.dir.getFileHandle(f.name)).getFile();
      const url = URL.createObjectURL(file);
      window.open(url, '_blank') || saveBlob(file, f.name);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      ui.done('opened');
    },
    async remove(name) { await host.dir.removeEntry(name).catch(e => toast('Delete failed: ' + e.message)); rescan(); },
  };

  $('#title').textContent = dir.name;
  $('#hostPanel').hidden = false;
  showHostCode();
  showApp();
  openHostPeer();
  await rescan();
  setInterval(rescan, 2000);
  addEventListener('beforeunload', e => { if (host.guests.size) e.preventDefault(); });
}

$('#copyBtn').onclick = () => {
  const link = shareLink(host.code);
  navigator.clipboard?.writeText(link).then(() => toast('Link copied'), () => toast(link));
};
$('#newLinkBtn').onclick = () => {
  if (!confirm('Make a new code? Everyone connected now will be disconnected.')) return;
  host.code = newCode(); store.set('landrop-code', host.code);
  host.peer?.destroy(); host.guests.clear();
  showHostCode(); openHostPeer();
};
$('#stopBtn').onclick = async () => {
  if (!confirm('Stop sharing this folder?')) return;
  host.peer?.destroy();
  await clearDirHandle();
  location.hash = ''; location.reload();
};

// ---------- GUEST: talks to the host over one data connection ----------

const guest = { code: null, peer: null, conn: null, nextId: 1, pending: new Map(), retryTimer: null };

function guestDC() { const dc = guest.conn?.dataChannel; return dc && dc.readyState === 'open' ? dc : null; }

function scheduleGuestRetry(delay = 4000) {
  clearTimeout(guest.retryTimer);
  guest.retryTimer = setTimeout(connectToHost, delay);
}

function connectToHost() {
  const peer = guest.peer;
  if (!peer || peer.destroyed) return;
  if (peer.disconnected) { peer.reconnect(); return; } // 'open' fires again and calls us back
  guest.conn?.close();
  const conn = guest.conn = peer.connect(PREFIX + guest.code, { serialization: 'raw', reliable: true });
  const openTimeout = setTimeout(() => { if (!conn.open) { conn.close(); scheduleGuestRetry(1000); } }, 15000);

  conn.on('open', () => { clearTimeout(openTimeout); setStatus('Connected', true); setNotice(''); });
  conn.on('data', onGuestData);
  conn.on('close', () => {
    clearTimeout(openTimeout);
    if (guest.conn !== conn) return;
    setStatus('Lost connection · retrying…', false);
    for (const p of guest.pending.values()) p.err('connection lost');
    guest.pending.clear();
    scheduleGuestRetry();
  });
  conn.on('error', () => {});
}

function onGuestData(d) {
  if (typeof d !== 'string') {
    const [id, bytes] = unframe(d);
    guest.pending.get(id)?.chunk(bytes);
    return;
  }
  let m; try { m = JSON.parse(d); } catch { return; }
  if (m.t === 'files') return setFiles(m.files);
  const p = guest.pending.get(m.id); if (!p) return;
  if (m.t === 'err') p.err(m.msg);
  else p[m.t]?.(m);
}

function startGuest(code) {
  guest.code = code.toUpperCase();
  $('#title').textContent = 'Share ' + guest.code;
  setStatus('Connecting…', false);

  backend = {
    openLabel: 'Download',
    upload(file, ui) {
      return new Promise(resolve => {
        const dc = guestDC();
        if (!dc) { ui.fail('not connected'); return resolve(); }
        const id = guest.nextId++;
        const p = {
          async ready() {
            const ok = await sendBlob(dc, id, file, () => !guest.pending.has(id), b => ui.progress(b));
            if (ok) ui.note('saving…');
          },
          saved(msg) { guest.pending.delete(id); ui.done(msg.name === file.name ? 'done' : 'saved as ' + msg.name); resolve(); },
          err(msg) { guest.pending.delete(id); ui.fail(msg); resolve(); },
        };
        guest.pending.set(id, p);
        sendJSON(dc, { t: 'put', id, name: file.name, size: file.size });
      });
    },
    async open(f, ui) {
      if (!guestDC()) return ui.fail('not connected');
      // Big files on desktop Chrome/Edge: stream straight to disk. Otherwise collect in memory.
      let sink = null;
      if (f.size > BIG_DOWNLOAD && window.showSaveFilePicker) {
        try {
          const w = await (await showSaveFilePicker({ suggestedName: f.name })).createWritable();
          sink = { write: b => w.write(b), close: () => w.close(), abort: () => w.abort() };
        } catch (e) { if (e.name === 'AbortError') return ui.fail('cancelled'); }
      }
      if (!sink) {
        const parts = [];
        sink = { write: b => { parts.push(b); }, close: () => saveBlob(new Blob(parts), f.name), abort: () => { parts.length = 0; } };
      }
      const dc = guestDC(); if (!dc) return ui.fail('not connected');
      const id = guest.nextId++;
      let size = f.size, got = 0, writes = Promise.resolve();
      guest.pending.set(id, {
        meta(m) { size = m.size; },
        chunk(bytes) {
          got += bytes.byteLength;
          writes = writes.then(() => sink.write(bytes));
          ui.progress(got);
        },
        end() {
          guest.pending.delete(id);
          writes.then(() => sink.close()).then(() => ui.done(), e => ui.fail(e.message));
        },
        err(msg) { guest.pending.delete(id); writes.finally(() => sink.abort()); ui.fail(msg); },
      });
      ui.note('starting…');
      sendJSON(dc, { t: 'get', id, name: f.name });
    },
    remove(name) {
      const dc = guestDC();
      if (!dc) return toast('Not connected');
      sendJSON(dc, { t: 'del', name });
    },
  };

  showApp();
  const peer = guest.peer = new Peer();
  peer.on('open', () => connectToHost());
  peer.on('disconnected', () => { setStatus('Offline · reconnecting…', false); scheduleGuestRetry(3000); });
  peer.on('error', e => {
    if (e.type === 'peer-unavailable') {
      setStatus('Host not online · retrying…', false);
      setNotice(`No one is sharing with code ${guest.code} right now. Check the code, or ask the host to open their LAN Drop tab. This page keeps trying.`);
      scheduleGuestRetry();
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
      setStatus('Offline · reconnecting…', false);
      scheduleGuestRetry(5000);
    } else {
      console.warn('peer error', e.type, e);
    }
  });
}

// ---------- start screen ----------

async function pickFolder() {
  try {
    const dir = await showDirectoryPicker({ id: 'landrop', mode: 'readwrite' });
    startHosting(dir);
  } catch (e) {
    if (e.name !== 'AbortError') toast('Could not use that folder: ' + e.message);
  }
}

async function initStart() {
  const code = location.hash.slice(1).replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (code) return startGuest(code);

  if (!window.showDirectoryPicker) {
    $('#pickBtn').disabled = true;
    $('#noPicker').hidden = false;
  } else {
    $('#pickBtn').onclick = pickFolder;
    const saved = await loadDirHandle();
    if (saved) {
      const btn = $('#resumeBtn');
      btn.textContent = `Resume sharing "${saved.name}"`;
      btn.hidden = false;
      btn.onclick = async () => {
        try {
          const perm = await saved.queryPermission({ mode: 'readwrite' });
          if (perm === 'granted' || await saved.requestPermission({ mode: 'readwrite' }) === 'granted') startHosting(saved);
          else toast('Permission was not given for that folder.');
        } catch { toast('That folder is no longer available. Choose it again.'); }
      };
    }
  }

  $('#joinForm').onsubmit = e => {
    e.preventDefault();
    const c = $('#code').value.replace(/[^a-z0-9]/gi, '').toUpperCase();
    if (c.length < 4) return toast('Enter the code from the host’s screen.');
    location.hash = c;
  };
}

addEventListener('hashchange', () => location.reload());
initStart();
