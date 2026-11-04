// LAN Drop (web) — share a folder on this computer with anyone who has the link.
// The host's browser reads/writes the folder via the File System Access API.
// Files travel device-to-device over WebRTC; the public PeerJS broker only introduces peers.
// When a network blocks direct connections, data goes through a Cloudflare TURN relay
// (still end-to-end encrypted). worker/ hands out short-lived relay credentials.

const $ = s => document.querySelector(s);
// Addresses for the same relay Worker (worker/), all tried at once. Some networks block the
// Cloudflare addresses *.workers.dev and *.pages.dev (relay-proxy/) resolve to; the custom
// domain gets addresses those networks can reach. Empty = direct connections only.
const RELAY_URLS = [
  'https://relay.mikkaiser.com',
  'https://lan-drop-relay.pages.dev',
  'https://lan-drop-turn.mikkaiser-ribeiro.workers.dev',
];
const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
const ICE_REFRESH = 60 * 60 * 1000; // relay credentials last 3 h; refresh well before then
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
// ms = 0 keeps the message up until toastHide().
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function toastHide() { clearTimeout(toastTimer); $('#toast').classList.remove('show'); }
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

// Protocol v2 (striped transfers): one WebRTC connection only keeps so much data in flight,
// which caps its speed on long or lossy routes such as the relay. v2 hosts let a guest open
// LANES connections; each transfer is split into SEG-sized segments spread across them.
// v2 binary frames: [id | V2 (u32)][byte offset (f64)][bytes]. The high bit keeps them apart
// from v1 frames, which older cached pages still send.
const PROTOCOL = 2;
const LANES = 4;
const SEG = 4 * 1024 * 1024;
const V2 = 0x80000000;
function frame2(id, offset, bytes) {
  const out = new Uint8Array(12 + bytes.byteLength);
  const v = new DataView(out.buffer);
  v.setUint32(0, (id | V2) >>> 0);
  v.setFloat64(4, offset);
  out.set(bytes, 12);
  return out.buffer;
}
function unframe2(buf) { const v = new DataView(buf); return [v.getUint32(0) & 0x7fffffff, v.getFloat64(4), new Uint8Array(buf, 12)]; }
const isFrame2 = buf => buf.byteLength >= 12 && new DataView(buf).getUint32(0) >= V2;

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

// ICE servers for WebRTC: STUN always, plus TURN relay credentials from our Worker when available.
// (PeerJS's built-in relay servers no longer exist, so we always pass our own list.)
let iceConfig = { iceServers: STUN };
let myPublicIp = '';   // reported by the Worker; sent to the host in 'hello'
let relayProblem = ''; // why the relay is off, e.g. the monthly limit was reached

async function fetchRelay(url, headers = {}) {
  // Don't hang on an address this network can't reach.
  const res = await fetch(url, { cache: 'no-store', headers, signal: AbortSignal.timeout(8000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `relay error ${res.status}`), { refused: true });
  return data;
}

// Bot check (Cloudflare Turnstile): the Worker only hands relay credentials to visitors of
// this page, not to scripts. Normally invisible; a checkbox appears only if Turnstile insists.
// Each token works once, so every loadIce() gets a fresh one. Empty key = no bot check.
const TURNSTILE_SITE_KEY = '0x4AAAAAAFx1HtOZSw2llBgp'; // public by design (Turnstile widget "LAN Drop")
let tsWidget = null, tsResolve = null, tsTimer = null;
async function turnstileToken() {
  if (!TURNSTILE_SITE_KEY) return '';
  // (Check for render(): a page element with id "turnstile" would also show up as window.turnstile.)
  const ready = () => typeof window.turnstile?.render === 'function';
  for (let i = 0; !ready() && i < 50; i++) await new Promise(r => setTimeout(r, 200));
  if (!ready()) return ''; // script blocked: the Worker will refuse, direct connections still work
  return new Promise(resolve => {
    const finish = token => { clearTimeout(tsTimer); tsResolve = null; resolve(token || ''); };
    tsTimer = setTimeout(() => finish(''), 30000);
    tsResolve = finish;
    try { runTurnstile(); } catch (e) { console.warn('turnstile failed', e); finish(''); }
  });
}
function runTurnstile() {
  if (tsWidget === null) {
    tsWidget = turnstile.render('#ts-box', {
      sitekey: TURNSTILE_SITE_KEY, execution: 'execute', appearance: 'interaction-only',
      callback: t => { toastHide(); tsResolve?.(t); },
      'error-callback': () => { tsResolve?.(''); return true; },
      // Turnstile wants a click: wait for the person (no time limit) and tell them where.
      'before-interactive-callback': () => {
        clearTimeout(tsTimer);
        toast('Tick the box at the bottom right to enable the relay.', 0);
      },
    });
  } else {
    turnstile.reset(tsWidget);
  }
  turnstile.execute(tsWidget);
}

// One fetch at a time (start-up, hourly refresh and guest retries can overlap),
// since they share the Turnstile widget.
let iceLoading = null;
function loadIce() { return iceLoading ||= loadIceOnce().finally(() => { iceLoading = null; }); }

async function loadIceOnce() {
  if (!RELAY_URLS.length) return iceConfig;
  try {
    let data;
    const token = await turnstileToken();
    // Same token and idempotency key to every address, so each can verify it.
    const headers = token ? { 'X-Turnstile-Token': token, 'X-Turnstile-Key': crypto.randomUUID() } : {};
    try { data = await Promise.any(RELAY_URLS.map(url => fetchRelay(url, headers))); }
    catch (all) {
      // The Worker answered but said no (e.g. monthly limit): stop using the relay.
      const refused = all.errors.find(e => e.refused);
      if (refused) { relayProblem = refused.message; iceConfig = { iceServers: STUN }; }
      throw refused || all.errors[0];
    }
    relayProblem = '';
    if (data.ip) myPublicIp = data.ip;
    // Browsers time out on port 53 relay URLs, so drop those.
    const servers = [].concat(data.iceServers || [])
      .map(s => ({ ...s, urls: [].concat(s.urls).filter(u => !/:53(\?|$)/.test(u)) }))
      .filter(s => s.urls.length);
    if (servers.some(s => s.urls.some(u => u.startsWith('turn')))) iceConfig = { iceServers: servers };
  } catch (e) { console.warn('relay unavailable, direct connections only', e); }
  return iceConfig;
}
const iceReady = loadIce();
const hasRelay = () => iceConfig.iceServers.some(s => [].concat(s.urls).some(u => u.startsWith('turn')));
// Keep credentials fresh for long-running tabs (PeerJS reads options.config for each new
// connection). Without a relay yet, try again every minute instead of every hour.
(function refreshIce() {
  setTimeout(() => loadIce().then(c => {
    for (const p of [host.peer, guest.peer]) if (p && !p.destroyed) p.options.config = c;
    if (host.peer) showRelayState();
  }).finally(refreshIce), RELAY_URLS.length && !hasRelay() ? 60 * 1000 : ICE_REFRESH);
})();

// Host only: say when the relay is off, since then only devices that can connect directly get in.
function showRelayState() {
  if (RELAY_URLS.length && relayProblem) setNotice(`Relay is off: ${relayProblem}. Only devices that can connect directly can join right now.`);
}

// Which address a connection actually uses (from the chosen ICE candidate pair).
async function remoteAddress(conn) {
  const pc = conn.peerConnection;
  if (!pc) return null;
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
  if (!pair) stats.forEach(r => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
  const remote = pair && stats.get(pair.remoteCandidateId);
  if (!remote) return null;
  return { ip: remote.address || remote.ip || '', type: remote.candidateType };
}

// "iPhone · Safari" style label so the host can tell devices apart.
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${browser}`;
}

// Send [start, end) of a Blob/File as v2 frames; onProgress(bytes) per block. False if stopped.
async function sendRange(dc, id, blob, start, end, isCancelled = () => false, onProgress = () => {}) {
  for (let off = start; off < end; off += BLOCK) {
    const bytes = new Uint8Array(await blob.slice(off, Math.min(off + BLOCK, end)).arrayBuffer());
    for (let i = 0; i < bytes.length; i += CHUNK) {
      await drain(dc);
      if (dc.readyState !== 'open' || isCancelled()) return false;
      dc.send(frame2(id, off + i, bytes.subarray(i, i + CHUNK)));
    }
    onProgress(bytes.length);
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
  let finished = false, started = 0, last = 0;
  return {
    progress(bytes) {
      const now = performance.now();
      if (!started) started = now;
      const p = size ? Math.min(100, Math.round(bytes / size * 100)) : 100;
      bar.style.width = p + '%';
      last = bytes;
      const secs = (now - started) / 1000;
      // Average speed so far, so people can see what their route actually manages.
      pct.textContent = secs > 1 ? `${p}% · ${fmtSize(Math.round(bytes / secs))}/s` : p + '%';
    },
    note(text) { pct.textContent = text; },
    done(text = 'done') {
      if (finished) return; finished = true;
      const secs = started ? (performance.now() - started) / 1000 : 0;
      if (secs > 1 && text === 'done') text = `done · ${fmtSize(Math.round(last / secs))}/s`;
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

// guests: conn -> { device, addr } for the "who's connected" list
// puts2: `${guest peer id}:${transfer id}` -> v2 upload being written (fed by all of that guest's lanes)
const host = { dir: null, code: null, peer: null, guests: new Map(), puts2: new Map(), incoming: new Set(), key: '', scanning: false, retries: 0, gen: 0 };

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
      for (const c of host.guests.keys()) sendJSON(c.dataChannel, { t: 'files', files: list, v: PROTOCOL });
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

// v2 uploads: segments arrive on any of the guest's lanes and are written at their offsets.
function receivePut2(conn, buf) {
  const [id, off, bytes] = unframe2(buf);
  const p = host.puts2.get(`${conn.peer}:${id}`);
  if (!p) return;
  const idx = Math.floor(off / p.seg);
  if (p.done.has(idx)) return;
  let s = p.segs.get(idx);
  if (!s || s.conn !== conn) p.segs.set(idx, s = { got: 0, conn }); // re-sent on another lane: count afresh
  s.got += bytes.byteLength;
  p.queue = p.queue.then(() => p.inc.writable.write({ type: 'write', position: off, data: bytes }));
  if (s.got >= Math.min(p.seg, p.size - idx * p.seg)) {
    p.done.add(idx); p.segs.delete(idx);
    sendJSON(conn.dataChannel, { t: 'ack', id, seg: idx });
    if (p.done.size === p.nsegs) finishPut2(p);
  }
}
function finishPut2(p) {
  host.puts2.delete(p.key);
  p.queue
    .then(() => p.inc.finish(true))
    .then(() => sendJSON(p.control.dataChannel, { t: 'saved', id: p.id, name: p.inc.name }),
          e => { p.inc.finish(false).catch(() => {}); sendJSON(p.control.dataChannel, { t: 'err', id: p.id, msg: e.message }); });
}
function abortPut2(p) {
  host.puts2.delete(p.key);
  p.queue.finally(() => p.inc.finish(false)).catch(() => {});
}

function acceptGuest(conn) {
  const gets = new Map(), puts = new Map();
  const ranges = new Map();                         // v2 downloads: `${id}:${start}` -> cancel
  const isLane = conn.metadata?.role === 'lane';    // extra connection of a guest already listed

  conn.on('open', () => {
    if (isLane) return;
    const info = { device: 'Connecting device', addr: null };
    host.guests.set(conn, info);
    updateGuestCount();
    sendJSON(conn.dataChannel, { t: 'files', files, v: PROTOCOL });
    // The chosen route can change in the first seconds, so look twice.
    const lookup = () => remoteAddress(conn).then(a => { if (a && host.guests.has(conn)) { info.addr = a; updateGuestCount(); } }).catch(() => {});
    lookup(); setTimeout(lookup, 3000);
  });

  conn.on('data', async d => {
    const dc = conn.dataChannel;
    if (typeof d !== 'string') {
      if (isFrame2(d)) return receivePut2(conn, d);
      const [id, bytes] = unframe(d);
      const p = puts.get(id); if (!p) return;
      p.got += bytes.byteLength;
      p.queue = p.queue.then(() => p.inc.writable.write(bytes));
      if (p.got >= p.size) finishPut(id, p);
      return;
    }
    let m; try { m = JSON.parse(d); } catch { return; }

    if (m.t === 'hello') {
      const info = host.guests.get(conn);
      if (info) {
        info.device = String(m.device || '').slice(0, 40) || 'Unknown device';
        info.publicIp = String(m.ip || '').slice(0, 45);
        updateGuestCount();
      }
    } else if (m.t === 'get') {
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
    } else if (m.t === 'stat') {
      try {
        if (!hostKnows(m.name)) throw new Error('file not found');
        const file = await (await host.dir.getFileHandle(m.name)).getFile();
        sendJSON(dc, { t: 'meta', id: m.id, size: file.size });
      } catch (e) { sendJSON(dc, { t: 'err', id: m.id, msg: e.message }); }
    } else if (m.t === 'range') {
      const key = `${m.id}:${m.start}`;
      let cancelled = false;
      ranges.set(key, () => { cancelled = true; });
      try {
        if (!hostKnows(m.name)) throw new Error('file not found');
        const file = await (await host.dir.getFileHandle(m.name)).getFile();
        await sendRange(dc, m.id, file, m.start, Math.min(m.end, file.size), () => cancelled);
      } catch (e) { sendJSON(dc, { t: 'err', id: m.id, msg: e.message }); }
      finally { ranges.delete(key); }
    } else if (m.t === 'put2') {
      try {
        const inc = await openIncoming(m.name);
        const size = Number(m.size) || 0, seg = Number(m.seg) || SEG;
        const p = { key: `${conn.peer}:${m.id}`, id: m.id, guest: conn.peer, control: conn, inc, size, seg,
                    nsegs: Math.ceil(size / seg), segs: new Map(), done: new Set(), queue: Promise.resolve() };
        host.puts2.set(p.key, p);
        if (!p.nsegs) finishPut2(p);
        else sendJSON(dc, { t: 'ready', id: m.id });
      } catch (e) { sendJSON(dc, { t: 'err', id: m.id, msg: e.message }); }
    } else if (m.t === 'del') {
      if (hostKnows(m.name)) await host.dir.removeEntry(m.name).catch(() => {});
      rescan();
    } else if (m.t === 'cancel') {
      gets.get(m.id)?.();
      for (const [key, cancel] of ranges) if (key.startsWith(m.id + ':')) cancel();
      const p = puts.get(m.id);
      if (p) { puts.delete(m.id); p.queue.finally(() => p.inc.finish(false)); }
      const p2 = host.puts2.get(`${conn.peer}:${m.id}`);
      if (p2) abortPut2(p2);
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
    for (const cancel of gets.values()) cancel();
    for (const cancel of ranges.values()) cancel();
    for (const p of puts.values()) p.queue.finally(() => p.inc.finish(false));
    puts.clear();
    if (isLane) return; // the guest re-sends that lane's segments on its other connections
    host.guests.delete(conn);
    for (const p of [...host.puts2.values()]) if (p.control === conn) abortPut2(p);
    updateGuestCount();
  });
}

// Best address we can show: the real one if the browser reveals it, else the guest's public IP.
// (Browsers hide local network IPs from web pages, so on a LAN the public IP is often all we get.)
function guestAddress({ addr, publicIp }) {
  const relay = addr?.type === 'relay' ? ' · via relay' : '';
  if (addr?.ip && !addr.ip.endsWith('.local') && addr.type !== 'relay') return addr.ip;
  if (publicIp) return `${publicIp} (public)${relay}`;
  if (!addr) return 'finding address…';
  return relay ? 'via relay (IP hidden)' : 'IP hidden by browser';
}

function updateGuestCount() {
  const list = $('#guestList');
  list.replaceChildren(...[...host.guests.values()].map(g =>
    el('li', {}, el('span', { textContent: g.device }), el('code', { textContent: guestAddress(g) }))));
  list.hidden = !host.guests.size;
  if (!host.peer || host.peer.disconnected) return;
  const n = host.guests.size;
  setStatus(n ? `Sharing · ${n} ${n > 1 ? 'people' : 'person'} connected` : 'Sharing · waiting for others to join', true);
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

async function openHostPeer() {
  const gen = ++host.gen; // a newer call (e.g. "New code") cancels pending retries of this one
  await iceReady;
  if (gen !== host.gen) return;
  const peer = host.peer = new Peer(PREFIX + host.code, { config: iceConfig });
  setStatus('Connecting to the broker…', false);
  peer.on('open', () => { host.retries = 0; setNotice(''); showRelayState(); updateGuestCount(); });
  peer.on('connection', acceptGuest);
  peer.on('disconnected', () => {
    // Network changed or dropped: keep the same code and reconnect.
    setStatus('Offline · reconnecting…', false);
    setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 3000);
  });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') {
      // Usually our own previous tab: the broker can take up to a minute to release its code.
      // Keep the same code (so links people already have keep working) and keep trying.
      peer.destroy();
      setStatus(`Waiting for code ${host.code} to be released · retrying…`, false);
      if (++host.retries === 3) {
        setNotice(`Code ${host.code} is still held by an earlier session. A closed tab can take up to a minute to let go of it; if this share is also open in another tab or on another computer, close it there. LAN Drop keeps trying. Click "New code" to stop waiting and use a new code instead.`);
      }
      setTimeout(() => { if (gen === host.gen) openHostPeer(); }, 5000);
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
  host.peer?.destroy(); host.guests.clear(); updateGuestCount();
  host.retries = 0; setNotice('');
  showHostCode(); openHostPeer();
};
$('#stopBtn').onclick = async () => {
  if (!confirm('Stop sharing this folder?')) return;
  host.peer?.destroy();
  await clearDirHandle();
  location.hash = ''; location.reload();
};

// ---------- GUEST: a control connection plus extra lanes for speed (protocol v2) ----------

// conn: control connection (file list, requests). lanes: extra connections for v2 transfers.
// transfers: v2 transfers in progress, told when lanes come and go.
const guest = { code: null, peer: null, conn: null, lanes: new Set(), hostV: 0, nextId: 1,
                pending: new Map(), transfers: new Set(), retryTimer: null };

function guestDC() { const dc = guest.conn?.dataChannel; return dc && dc.readyState === 'open' ? dc : null; }
function guestLanes() { return [guest.conn, ...guest.lanes].filter(c => c?.dataChannel?.readyState === 'open'); }

function openLane() {
  const peer = guest.peer, control = guest.conn;
  if (!peer || peer.destroyed || peer.disconnected || !control?.open) return;
  const lane = peer.connect(PREFIX + guest.code, { serialization: 'raw', reliable: true, metadata: { role: 'lane' } });
  lane.on('open', () => {
    if (guest.conn !== control) return lane.close();
    guest.lanes.add(lane);
    for (const t of guest.transfers) t.pump();
  });
  lane.on('data', d => onGuestData(d, lane));
  lane.on('close', () => {
    if (!guest.lanes.delete(lane)) return;
    for (const t of guest.transfers) t.laneLost(lane);
    setTimeout(() => { if (guest.conn === control && control.open && guest.lanes.size < LANES - 1) openLane(); }, 3000);
  });
  lane.on('error', () => {});
}

// Hands segments of [0, size) to open lanes, keeping up to `slots` in flight per lane.
// start(idx, lane, from, to) begins one; finishSeg(idx) when it's complete (true when all are);
// laneLost(lane) puts that lane's unfinished segments back in the queue for the others.
function stripe(size, slots, start) {
  const n = Math.ceil(size / SEG), queue = [...Array(n).keys()], inflight = new Map(), load = new Map();
  let done = 0;
  const s = {
    segLen: idx => Math.min(SEG, size - idx * SEG),
    owner: idx => inflight.get(idx),
    pump() {
      for (const lane of guestLanes()) {
        while ((load.get(lane) || 0) < slots && queue.length) {
          const idx = queue.shift();
          inflight.set(idx, { lane, got: 0 });
          load.set(lane, (load.get(lane) || 0) + 1);
          start(idx, lane, idx * SEG, idx * SEG + s.segLen(idx));
        }
      }
    },
    finishSeg(idx) {
      const f = inflight.get(idx);
      if (!f) return false;
      inflight.delete(idx); load.set(f.lane, load.get(f.lane) - 1); done++;
      if (done < n) s.pump();
      return done === n;
    },
    laneLost(lane) {
      for (const [idx, f] of inflight) if (f.lane === lane) { inflight.delete(idx); queue.unshift(idx); }
      load.delete(lane);
      s.pump();
    },
  };
  return s;
}

function download2(f, ui, sink) {
  return new Promise(resolve => {
    const id = guest.nextId++;
    let got = 0, writes = Promise.resolve(), st = null;
    const t = {
      meta(m) {
        if (!m.size) return t.complete();
        st = stripe(m.size, 2, (idx, lane, from, to) => sendJSON(lane.dataChannel, { t: 'range', id, name: f.name, start: from, end: to }));
        ui.progress(0); st.pump();
      },
      chunk2(off, bytes, lane) {
        const idx = Math.floor(off / SEG), o = st?.owner(idx);
        if (!o || o.lane !== lane) return; // late data from a segment that moved lanes
        o.got += bytes.byteLength; got += bytes.byteLength; ui.progress(got);
        writes = writes.then(() => sink.write(off, bytes));
        if (o.got >= st.segLen(idx) && st.finishSeg(idx)) t.complete();
      },
      pump() { st?.pump(); },
      laneLost(lane) { st?.laneLost(lane); },
      complete() { cleanup(); writes.then(() => sink.close()).then(() => ui.done(), e => ui.fail(e.message)).finally(resolve); },
      err(msg) { cleanup(); writes.finally(() => sink.abort()); ui.fail(msg); resolve(); },
    };
    const cleanup = () => { guest.pending.delete(id); guest.transfers.delete(t); };
    guest.pending.set(id, t); guest.transfers.add(t);
    ui.note('starting…');
    sendJSON(guestDC(), { t: 'stat', id, name: f.name });
  });
}

function upload2(file, ui) {
  return new Promise(resolve => {
    const id = guest.nextId++;
    let sent = 0, st = null;
    const t = {
      ready() {
        // Each slot sends a segment, then waits for the host's 'ack' before taking another.
        st = stripe(file.size, 2, (idx, lane, from, to) => sendRange(lane.dataChannel, id, file, from, to,
          () => !guest.pending.has(id) || st.owner(idx)?.lane !== lane,
          b => { sent += b; ui.progress(Math.min(sent, file.size)); }));
        st.pump();
      },
      ack(m, lane) {
        const o = st?.owner(m.seg);
        if (o && o.lane === lane && st.finishSeg(m.seg)) ui.note('saving…');
      },
      pump() { st?.pump(); },
      laneLost(lane) { st?.laneLost(lane); },
      saved(m) { cleanup(); ui.done(m.name === file.name ? 'done' : 'saved as ' + m.name); resolve(); },
      err(msg) { cleanup(); ui.fail(msg); resolve(); },
    };
    const cleanup = () => { guest.pending.delete(id); guest.transfers.delete(t); };
    const dc = guestDC();
    if (!dc) { ui.fail('not connected'); return resolve(); }
    guest.pending.set(id, t); guest.transfers.add(t);
    sendJSON(dc, { t: 'put2', id, name: file.name, size: file.size, seg: SEG });
  });
}

// Where downloads go: straight to disk for big files on desktop Chrome/Edge, else memory.
// Returns null if the person cancelled the save dialog.
async function downloadSink(f) {
  if (f.size > BIG_DOWNLOAD && window.showSaveFilePicker) {
    try {
      const w = await (await showSaveFilePicker({ suggestedName: f.name })).createWritable();
      return { write: (off, b) => w.write({ type: 'write', position: off, data: b }), close: () => w.close(), abort: () => w.abort() };
    } catch (e) { if (e.name === 'AbortError') return null; }
  }
  // Keyed by offset: a segment re-sent on another lane replaces what the lost lane delivered.
  const parts = new Map();
  return {
    write: (off, b) => { parts.set(off, b); },
    close: () => saveBlob(new Blob([...parts.keys()].sort((a, b) => a - b).map(k => parts.get(k))), f.name),
    abort: () => { parts.clear(); },
  };
}

function scheduleGuestRetry(delay = 4000) {
  clearTimeout(guest.retryTimer);
  guest.retryTimer = setTimeout(connectToHost, delay);
}

async function connectToHost() {
  const peer = guest.peer;
  if (!peer || peer.destroyed) return;
  if (peer.disconnected) { peer.reconnect(); return; } // 'open' fires again and calls us back
  // No relay yet (e.g. the Worker was unreachable): try again before each attempt.
  if (RELAY_URLS.length && !hasRelay()) peer.options.config = await loadIce();
  guest.conn?.close();
  for (const lane of guest.lanes) lane.close();
  guest.lanes.clear(); guest.hostV = 0;
  const conn = guest.conn = peer.connect(PREFIX + guest.code, { serialization: 'raw', reliable: true });
  // The host was found but no network route worked (direct blocked, and no relay or relay failed).
  const unreachable = () => {
    if (conn.open || guest.conn !== conn) return;
    clearTimeout(openTimeout);
    setStatus("Can't reach the host · retrying…", false);
    setNotice(hasRelay()
      ? 'Found the host but could not connect, even through the relay. Check that both devices have internet access. This page keeps trying.'
      : `Found the host, but this network blocks direct connections between devices and the relay is off${relayProblem ? ` (${relayProblem})` : ''}. Try a different network, for example a phone hotspot. This page keeps trying.`);
    conn.close(); scheduleGuestRetry(5000);
  };
  const openTimeout = setTimeout(unreachable, 20000);
  conn.peerConnection?.addEventListener('iceconnectionstatechange', () => {
    if (conn.peerConnection.iceConnectionState === 'failed') unreachable();
  });

  conn.on('open', () => {
    clearTimeout(openTimeout); setStatus('Connected', true); setNotice('');
    sendJSON(conn.dataChannel, { t: 'hello', device: deviceLabel(), ip: myPublicIp });
  });
  conn.on('data', d => onGuestData(d, conn));
  conn.on('close', () => {
    clearTimeout(openTimeout);
    if (guest.conn !== conn) return;
    setStatus('Lost connection · retrying…', false);
    for (const lane of guest.lanes) lane.close();
    guest.lanes.clear();
    for (const p of [...guest.pending.values()]) p.err('connection lost');
    guest.pending.clear(); guest.transfers.clear();
    scheduleGuestRetry();
  });
  conn.on('error', () => {});
}

function onGuestData(d, conn) {
  if (typeof d !== 'string') {
    if (isFrame2(d)) {
      const [id, off, bytes] = unframe2(d);
      guest.pending.get(id)?.chunk2?.(off, bytes, conn);
    } else {
      const [id, bytes] = unframe(d);
      guest.pending.get(id)?.chunk?.(bytes);
    }
    return;
  }
  let m; try { m = JSON.parse(d); } catch { return; }
  if (m.t === 'files') {
    // A v2 host: open the extra lanes once per control connection.
    if (conn === guest.conn && m.v >= 2 && !guest.hostV) {
      guest.hostV = m.v;
      for (let i = 1; i < LANES; i++) openLane();
    }
    return setFiles(m.files);
  }
  const p = guest.pending.get(m.id); if (!p) return;
  if (m.t === 'err') p.err(m.msg);
  else p[m.t]?.(m, conn);
}

async function startGuest(code) {
  guest.code = code.toUpperCase();
  $('#title').textContent = 'Share ' + guest.code;
  setStatus('Connecting…', false);

  backend = {
    openLabel: 'Download',
    upload(file, ui) {
      if (guest.hostV >= 2) return upload2(file, ui);
      // v1 host (older cached page): one stream on the control connection.
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
      const sink = await downloadSink(f);
      if (!sink) return ui.fail('cancelled');
      if (guest.hostV >= 2) return download2(f, ui, sink);
      // v1 host (older cached page): one in-order stream on the control connection.
      let pos = 0;
      const dc = guestDC(); if (!dc) return ui.fail('not connected');
      const id = guest.nextId++;
      let size = f.size, got = 0, writes = Promise.resolve();
      guest.pending.set(id, {
        meta(m) { size = m.size; },
        chunk(bytes) {
          const off = pos; pos += bytes.byteLength;
          got += bytes.byteLength;
          writes = writes.then(() => sink.write(off, bytes));
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
  await iceReady;
  const peer = guest.peer = new Peer({ config: iceConfig });
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
  const myCode = store.get('landrop-code');
  const saved = window.showDirectoryPicker ? await loadDirHandle() : null;
  // Opening your own share link means "resume hosting", not "join it as a guest".
  if (code && !(saved && code === myCode)) return startGuest(code);
  if (code) history.replaceState(null, '', location.pathname);

  if (!window.showDirectoryPicker) {
    $('#pickBtn').disabled = true;
    $('#noPicker').hidden = false;
  } else {
    $('#pickBtn').onclick = pickFolder;
    if (saved) {
      // If Chrome remembers the folder permission ("Allow on every visit"), resume right away.
      if (await saved.queryPermission({ mode: 'readwrite' }).catch(() => 'denied') === 'granted') return startHosting(saved);
      const btn = $('#resumeBtn');
      btn.textContent = `Resume sharing "${saved.name}"`;
      btn.hidden = false;
      // Make resuming the obvious next step.
      btn.className = 'btn primary'; $('#pickBtn').className = 'btn';
      $('#pickBtn').textContent = 'Choose a different folder…';
      const note = $('#resumeNote');
      note.textContent = `Your share${myCode ? ` (code ${myCode})` : ''} is offline until you click Resume sharing. People who have your link can't connect until then.`;
      note.hidden = false;
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

// ---------- "How LAN Drop works" video (footer) ----------

// The 50 s video is only downloaded when someone opens it.
const VIDEO_SRC = 'how-lan-drop-works.mp4';
function openHowVideo() {
  const video = $('#howVideo');
  if (!video.src) video.src = VIDEO_SRC;
  $('#howModal').hidden = false;
  $('#howClose').focus();
  video.play().catch(() => {}); // autoplay with sound may be refused; the controls are there
}
function closeHowVideo() {
  $('#howVideo').pause();
  $('#howModal').hidden = true;
  $('#howBtn').focus();
}
$('#howBtn').onclick = openHowVideo;
$('#howClose').onclick = closeHowVideo;
$('#howModal').addEventListener('click', e => { if (e.target === $('#howModal')) closeHowVideo(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#howModal').hidden) closeHowVideo(); });

addEventListener('hashchange', () => location.reload());
initStart();
