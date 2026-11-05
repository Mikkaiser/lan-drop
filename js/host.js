// Hosting: this browser owns the shared folder (File System Access API) and serves it to
// guests over PeerJS. Each guest connection becomes a GuestSession; see protocol.js for the
// messages. Also: the share code, the people list with each person's route, and the hint for
// turning on direct local-network connections.

import {
  BLOCK_BYTES, BROKER_PREFIX, DISCONNECT_GRACE_MS, FOLDER_RESCAN_MS, GUEST_TIMEOUT_MS,
  PROTOCOL_VERSION, SEGMENT_BYTES, STORAGE_CODE_KEY,
} from './config.js';
import { setupModal } from './modals.js';
import { isFrameV2, sendJSON, sendRange, sendWholeFile, unframeV1, unframeV2 } from './protocol.js';
import { onRelayRefresh, relay, relayEnabled, relayReady } from './relay.js';
import { chosenAddress, localAddressMode, ROUTE_LABEL, routeOf } from './routes.js';
import { setBackend, setFiles, setNotice, setStatus, showApp } from './files-view.js';
import { $, copyToClipboard, el, newShareCode, safeName, saveBlob, savedFolder, settings, shareLink, toast } from './util.js';

const host = {
  folder: null,               // FileSystemDirectoryHandle being shared
  files: [],                  // its contents as last read: [{ name, size, mtime }]
  filesKey: '',               // JSON of `files`, to notice changes
  incoming: new Set(),        // names being written right now (hidden from the list until done)
  scanning: false,
  code: null,
  peer: null,
  peerGeneration: 0,          // a newer connectToBroker() cancels the retries of older ones
  codeRetries: 0,
  sessions: new Map(),        // control connection -> GuestSession (lanes aren't listed)
  stripedUploads: new Map(),  // `${guest peer id}:${transfer id}` -> v2 upload in progress
  lanMode: 'unknown',         // does this browser hide its local address? see routes.js
};

// ---------- The folder ----------

async function readFolder() {
  const list = [];
  for await (const [name, handle] of host.folder.entries()) {
    if (handle.kind !== 'file' || name.startsWith('.') || name.endsWith('.crswap') || host.incoming.has(name)) continue;
    try {
      const file = await handle.getFile();
      list.push({ name, size: file.size, mtime: file.lastModified });
    } catch { /* deleted while listing */ }
  }
  return list.sort((a, b) => b.mtime - a.mtime);
}

/** Re-read the folder; if anything changed, update the view and tell every guest. */
async function rescanFolder() {
  if (host.scanning || !host.folder) return;
  host.scanning = true;
  try {
    const list = await readFolder();
    const key = JSON.stringify(list);
    if (key !== host.filesKey) {
      host.files = list;
      host.filesKey = key;
      setFiles(list);
      for (const session of host.sessions.values()) session.reply({ t: 'files', files: list, v: PROTOCOL_VERSION });
    }
  } catch (e) {
    setNotice(`Lost access to the folder (${e.message}). Click "Stop sharing" and choose it again.`);
  } finally {
    host.scanning = false;
  }
}

/** Guests may only touch files that are in the list (never paths or hidden files). */
const isListed = name => host.files.some(f => f.name === name);
const readListedFile = async name => {
  if (!isListed(name)) throw new Error('file not found');
  return (await host.folder.getFileHandle(name)).getFile();
};

async function exists(name) {
  try { await host.folder.getFileHandle(name); return true; } catch { return false; }
}
/** "report.pdf" -> "report (1).pdf" if taken. */
async function freeName(name) {
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let candidate = name;
  for (let i = 1; host.incoming.has(candidate) || await exists(candidate); i++) candidate = `${base} (${i})${ext}`;
  return candidate;
}

/**
 * Start writing a new file into the folder. Returns { name, writable, finish(ok) };
 * finish(false) deletes the partial file.
 */
async function createIncomingFile(requestedName) {
  const name = await freeName(safeName(requestedName));
  host.incoming.add(name);
  try {
    const writable = await (await host.folder.getFileHandle(name, { create: true })).createWritable();
    return {
      name,
      writable,
      async finish(ok) {
        try {
          if (ok) await writable.close(); else await writable.abort();
        } finally {
          host.incoming.delete(name);
          if (!ok) await host.folder.removeEntry(name).catch(() => {});
          rescanFolder();
        }
      },
    };
  } catch (e) {
    host.incoming.delete(name);
    throw e;
  }
}

// ---------- v2 uploads: segments from any of a guest's lanes, written at their offsets ----------

function receiveSegment(conn, buffer) {
  const [id, offset, bytes] = unframeV2(buffer);
  const upload = host.stripedUploads.get(`${conn.peer}:${id}`);
  if (!upload) return;
  const index = Math.floor(offset / upload.segmentBytes);
  if (upload.done.has(index)) return;

  let segment = upload.segments.get(index);
  if (!segment || segment.conn !== conn) upload.segments.set(index, segment = { got: 0, conn }); // re-sent on another lane: count afresh
  segment.got += bytes.byteLength;
  upload.writes = upload.writes.then(() => upload.file.writable.write({ type: 'write', position: offset, data: bytes }));

  if (segment.got >= Math.min(upload.segmentBytes, upload.size - index * upload.segmentBytes)) {
    upload.done.add(index);
    upload.segments.delete(index);
    sendJSON(conn.dataChannel, { t: 'ack', id, seg: index });
    if (upload.done.size === upload.segmentCount) finishStripedUpload(upload);
  }
}

function finishStripedUpload(upload) {
  host.stripedUploads.delete(upload.key);
  upload.writes
    .then(() => upload.file.finish(true))
    .then(() => upload.session.reply({ t: 'saved', id: upload.id, name: upload.file.name }),
      e => { upload.file.finish(false).catch(() => {}); upload.session.reply({ t: 'err', id: upload.id, msg: e.message }); });
}

function abortStripedUpload(upload) {
  host.stripedUploads.delete(upload.key);
  upload.writes.finally(() => upload.file.finish(false)).catch(() => {});
}

// ---------- One guest connection ----------

// Message type -> GuestSession method (see protocol.js for what each carries).
const HANDLERS = {
  hello: 'onHello', ping: 'onPing', bye: 'onBye',
  stat: 'onStat', range: 'onRange', put2: 'onStripedUpload',
  get: 'onDownload', put: 'onUpload',
  del: 'onDelete', cancel: 'onCancel',
};

class GuestSession {
  constructor(conn) {
    this.conn = conn;
    this.isLane = conn.metadata?.role === 'lane'; // an extra connection of a guest already listed
    // Shown in the host's list (control connections only):
    this.device = 'Connecting device';
    this.address = null;   // chosenAddress()
    this.publicIp = '';
    this.lastSeen = Date.now();
    this.sendsHeartbeat = false; // older cached pages don't
    // Transfers on this connection:
    this.downloads = new Map(); // v1 id -> cancel()
    this.ranges = new Map();    // v2 `${id}:${start}` -> cancel()
    this.uploads = new Map();   // v1 id -> { file, size, got, writes }
    this.gone = false;

    conn.on('open', () => this.onOpen());
    conn.on('data', data => this.onData(data));
    conn.on('close', () => this.drop());
  }

  reply(message) { sendJSON(this.conn.dataChannel, message); }

  onOpen() {
    this.watchConnection();
    if (this.isLane) return;
    host.sessions.set(this.conn, this);
    updateGuestList();
    this.reply({ t: 'files', files: host.files, v: PROTOCOL_VERSION });
    // The chosen route can change in the first seconds, so look twice.
    const lookUp = () => chosenAddress(this.conn).then(address => {
      if (address && host.sessions.has(this.conn)) { this.address = address; updateGuestList(); }
    }).catch(() => {});
    lookUp();
    setTimeout(lookUp, 3000);
  }

  // PeerJS often reports no close when the other side just disappears (tab closed, laptop
  // asleep, Wi-Fi lost), so watch the connection itself too.
  watchConnection() {
    const pc = this.conn.peerConnection;
    if (!pc) return;
    let grace = null;
    pc.addEventListener('connectionstatechange', () => {
      clearTimeout(grace);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.drop();
      else if (pc.connectionState === 'disconnected') {
        grace = setTimeout(() => { if (pc.connectionState !== 'connected') this.drop(); }, DISCONNECT_GRACE_MS);
      }
    });
    this.conn.dataChannel?.addEventListener('close', () => this.drop());
  }

  /** Stop everything on this connection; safe to call more than once. */
  drop() {
    if (this.gone) return;
    this.gone = true;
    for (const cancel of this.downloads.values()) cancel();
    for (const cancel of this.ranges.values()) cancel();
    for (const upload of this.uploads.values()) upload.writes.finally(() => upload.file.finish(false));
    this.uploads.clear();
    if (this.conn.open) this.conn.close();
    if (this.isLane) return; // the guest re-sends that lane's segments on its other lanes
    host.sessions.delete(this.conn);
    for (const upload of [...host.stripedUploads.values()]) if (upload.session === this) abortStripedUpload(upload);
    updateGuestList();
  }

  async onData(data) {
    if (typeof data !== 'string') return this.onFileData(data);
    let message;
    try { message = JSON.parse(data); } catch { return; }
    this.lastSeen = Date.now();
    const handler = HANDLERS[message.t];
    if (handler) await this[handler](message);
  }

  onFileData(buffer) {
    if (isFrameV2(buffer)) return receiveSegment(this.conn, buffer);
    const [id, bytes] = unframeV1(buffer);
    const upload = this.uploads.get(id);
    if (!upload) return;
    upload.got += bytes.byteLength;
    upload.writes = upload.writes.then(() => upload.file.writable.write(bytes));
    if (upload.got >= upload.size) this.finishUpload(id, upload);
  }

  // --- who is this ---

  onHello({ device, ip }) {
    this.device = String(device || '').slice(0, 40) || 'Unknown device';
    this.publicIp = String(ip || '').slice(0, 45);
    updateGuestList();
  }
  onPing() { this.sendsHeartbeat = true; }
  onBye() { this.drop(); }

  // --- v2 transfers ---

  async onStat({ id, name }) {
    try { this.reply({ t: 'meta', id, size: (await readListedFile(name)).size }); }
    catch (e) { this.reply({ t: 'err', id, msg: e.message }); }
  }

  async onRange({ id, name, start, end }) {
    const key = `${id}:${start}`;
    let cancelled = false;
    this.ranges.set(key, () => { cancelled = true; });
    try {
      const file = await readListedFile(name);
      await sendRange(this.conn.dataChannel, id, file, start, Math.min(end, file.size), () => cancelled);
    } catch (e) {
      this.reply({ t: 'err', id, msg: e.message });
    } finally {
      this.ranges.delete(key);
    }
  }

  async onStripedUpload({ id, name, size, seg }) {
    try {
      const file = await createIncomingFile(name);
      const upload = {
        key: `${this.conn.peer}:${id}`, id, session: this, file,
        size: Number(size) || 0, segmentBytes: Number(seg) || SEGMENT_BYTES,
        segments: new Map(), done: new Set(), writes: Promise.resolve(),
      };
      upload.segmentCount = Math.ceil(upload.size / upload.segmentBytes);
      host.stripedUploads.set(upload.key, upload);
      if (upload.segmentCount === 0) finishStripedUpload(upload);
      else this.reply({ t: 'ready', id });
    } catch (e) {
      this.reply({ t: 'err', id, msg: e.message });
    }
  }

  // --- v1 transfers (older cached guest pages) ---

  async onDownload({ id, name }) {
    let cancelled = false;
    this.downloads.set(id, () => { cancelled = true; });
    try {
      const file = await readListedFile(name);
      this.reply({ t: 'meta', id, size: file.size });
      if (await sendWholeFile(this.conn.dataChannel, id, file, () => cancelled)) this.reply({ t: 'end', id });
    } catch (e) {
      this.reply({ t: 'err', id, msg: e.message });
    } finally {
      this.downloads.delete(id);
    }
  }

  async onUpload({ id, name, size }) {
    try {
      const upload = { file: await createIncomingFile(name), size: Number(size) || 0, got: 0, writes: Promise.resolve() };
      this.uploads.set(id, upload);
      if (upload.size === 0) this.finishUpload(id, upload);
      else this.reply({ t: 'ready', id });
    } catch (e) {
      this.reply({ t: 'err', id, msg: e.message });
    }
  }

  finishUpload(id, upload) {
    this.uploads.delete(id);
    upload.writes
      .then(() => upload.file.finish(true))
      .then(() => this.reply({ t: 'saved', id, name: upload.file.name }),
        e => { upload.file.finish(false).catch(() => {}); this.reply({ t: 'err', id, msg: e.message }); });
  }

  // --- the rest ---

  async onDelete({ name }) {
    if (isListed(name)) await host.folder.removeEntry(name).catch(() => {});
    rescanFolder();
  }

  onCancel({ id }) {
    this.downloads.get(id)?.();
    for (const [key, cancel] of this.ranges) if (key.startsWith(id + ':')) cancel();
    const upload = this.uploads.get(id);
    if (upload) { this.uploads.delete(id); upload.writes.finally(() => upload.file.finish(false)); }
    const striped = host.stripedUploads.get(`${this.conn.peer}:${id}`);
    if (striped) abortStripedUpload(striped);
  }
}

// Backstop for guests that vanish without any signal: pages that send heartbeats and have gone
// quiet are dropped. (Pages that never sent one are older versions; they drop when they close.)
setInterval(() => {
  for (const session of [...host.sessions.values()]) {
    if (session.sendsHeartbeat && Date.now() - session.lastSeen > GUEST_TIMEOUT_MS) session.drop();
  }
}, 10 * 1000);

// ---------- People list, routes and the direct-connection hint ----------

/** The best address we can show: the real one if the browser reveals it, else the public IP. */
function addressText({ address, publicIp }) {
  if (address?.ip && !address.ip.endsWith('.local') && address.type !== 'relay') return address.ip;
  if (publicIp) return `${publicIp} (public)`;
  return address ? 'IP hidden by browser' : 'finding address…';
}
const isOnOurNetwork = session => !!session.publicIp && session.publicIp === relay.publicIp;

function updateGuestList() {
  const sessions = [...host.sessions.values()];
  $('#guestList').replaceChildren(...sessions.map(session => {
    const route = routeOf(session.address, isOnOurNetwork(session));
    return el('li', {},
      el('span', { textContent: session.device }),
      route ? el('code', { className: 'route ' + route, textContent: ROUTE_LABEL[route] }) : '',
      el('code', { textContent: addressText(session) }));
  }));
  $('#guestList').hidden = !sessions.length;
  updateLanHint();
  if (!host.peer || host.peer.disconnected) return;
  const n = sessions.length;
  setStatus(n ? `Sharing · ${n} ${n > 1 ? 'people' : 'person'} connected` : 'Sharing · waiting for others to join', true);
}

const lanHelp = setupModal('lanHelp', {
  closeId: 'lanHelpClose',
  onOpen() {
    $('#lanHelpState').textContent = host.lanMode === 'shown'
      ? 'This browser shares its local address: direct connections are on.'
      : 'This browser hides its local address right now.';
  },
});
$('#lanHintBtn').onclick = e => lanHelp.open(e.currentTarget);
for (const button of document.querySelectorAll('[data-copy]')) button.onclick = () => copyToClipboard(button.dataset.copy);

/** "Direct local-network connections: on / off · how to turn on" under the share code. */
function showLanMode() {
  const line = $('#lanMode');
  line.replaceChildren();
  if (host.lanMode === 'shown') {
    line.append('Direct local-network connections: on');
  } else if (host.lanMode === 'hidden') {
    const how = el('button', { className: 'linkish', type: 'button', textContent: 'how to turn on' });
    how.onclick = e => lanHelp.open(e.currentTarget);
    line.append('Direct local-network connections: off · ', how);
  }
  line.hidden = host.lanMode === 'unknown';
}

/** Someone on our network (same public IP) still going through the relay is slower than needed. */
function updateLanHint() {
  const slow = [...host.sessions.values()].filter(s => routeOf(s.address) === 'relay' && relay.publicIp && isOnOurNetwork(s));
  $('#lanHint').hidden = !slow.length;
  if (!slow.length) return;
  const who = `${slow.map(s => s.device).join(', ')} ${slow.length > 1 ? 'are' : 'is'}`;
  if (host.lanMode === 'shown') {
    $('#lanHintText').textContent = `${who} on your network but going through the relay. This browser already shares its local address, so this network probably keeps devices from reaching each other (common on staff and guest Wi-Fi). The relay is the only route here.`;
    $('#lanHintBtn').hidden = true;
  } else {
    $('#lanHintText').textContent = `${who} on your network but going through the relay, which is slower. Turn on direct connections in this browser for full local-network speed.`;
    $('#lanHintBtn').hidden = false;
  }
}

/** When the relay is off, only devices that can connect directly can join; say so. */
function showRelayProblem() {
  if (relayEnabled && relay.problem) {
    setNotice(`Relay is off: ${relay.problem}. Only devices that can connect directly can join right now.`);
  }
}

// ---------- Share code and broker ----------

function showShareCode() {
  const link = shareLink(host.code);
  $('#hostCode').textContent = host.code;
  $('#hostLink').textContent = link;
  $('#hostLink').href = link;
  if (window.qrcode) {
    const qr = window.qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    $('#qr').replaceChildren(el('img', { src: qr.createDataURL(6, 0), alt: 'QR code for the share link' }));
  }
}

/** Register our share code on the broker and accept guests; keeps the same code through hiccups. */
async function connectToBroker() {
  const generation = ++host.peerGeneration;
  await relayReady;
  if (generation !== host.peerGeneration) return;

  const peer = host.peer = new window.Peer(BROKER_PREFIX + host.code, { config: relay.config });
  setStatus('Connecting to the broker…', false);
  peer.on('open', () => { host.codeRetries = 0; setNotice(''); showRelayProblem(); updateGuestList(); });
  peer.on('connection', conn => new GuestSession(conn));
  peer.on('disconnected', () => {
    // Network changed or dropped: keep the same code and reconnect.
    setStatus('Offline · reconnecting…', false);
    setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 3000);
  });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') {
      // Usually our own previous tab: the broker can take up to a minute to release its code.
      // Keep the code (links people already have keep working) and keep trying.
      peer.destroy();
      setStatus(`Waiting for code ${host.code} to be released · retrying…`, false);
      if (++host.codeRetries === 3) {
        setNotice(`Code ${host.code} is still held by an earlier session. A closed tab can take up to a minute to let go of it; if this share is also open in another tab or on another computer, close it there. LAN Drop keeps trying. Click "New code" to stop waiting and use a new code instead.`);
      }
      setTimeout(() => { if (generation === host.peerGeneration) connectToBroker(); }, 5000);
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
      setStatus('Offline · reconnecting…', false);
      setTimeout(() => { if (!peer.destroyed && peer.disconnected) peer.reconnect(); }, 5000);
    } else {
      console.warn('peer error', e.type, e);
    }
  });
}

$('#copyBtn').onclick = () => copyToClipboard(shareLink(host.code), 'Link copied');

$('#newLinkBtn').onclick = () => {
  if (!confirm('Make a new code? Everyone connected now will be disconnected.')) return;
  host.code = newShareCode();
  settings.set(STORAGE_CODE_KEY, host.code);
  host.peer?.destroy();
  host.sessions.clear();
  updateGuestList();
  host.codeRetries = 0;
  setNotice('');
  showShareCode();
  connectToBroker();
};

$('#stopBtn').onclick = async () => {
  if (!confirm('Stop sharing this folder?')) return;
  host.peer?.destroy();
  await savedFolder.clear();
  location.hash = '';
  location.reload();
};

// ---------- Start ----------

/** What "Open", uploads and "Delete" mean on the host: work on the folder directly. */
const hostBackend = {
  openLabel: 'Open',
  async open(entry, row) {
    const file = await (await host.folder.getFileHandle(entry.name)).getFile();
    const url = URL.createObjectURL(file);
    window.open(url, '_blank') || saveBlob(file, entry.name);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    row.done('opened');
  },
  async upload(file, row) {
    const incoming = await createIncomingFile(file.name);
    try {
      for (let offset = 0; offset < file.size; offset += BLOCK_BYTES) {
        await incoming.writable.write(file.slice(offset, offset + BLOCK_BYTES));
        row.progress(Math.min(offset + BLOCK_BYTES, file.size));
      }
      await incoming.finish(true);
      row.done(incoming.name === safeName(file.name) ? 'done' : 'saved as ' + incoming.name);
    } catch (e) {
      await incoming.finish(false).catch(() => {});
      throw e;
    }
  },
  async remove(name) {
    await host.folder.removeEntry(name).catch(e => toast('Delete failed: ' + e.message));
    rescanFolder();
  },
};

/** Share `folder` (a directory handle the person granted read-write access to). */
export async function startHosting(folder) {
  host.folder = folder;
  host.code = settings.get(STORAGE_CODE_KEY) || newShareCode();
  settings.set(STORAGE_CODE_KEY, host.code);
  savedFolder.save(folder);

  setBackend(hostBackend);
  $('#title').textContent = folder.name;
  $('#hostPanel').hidden = false;
  showShareCode();
  showApp();

  onRelayRefresh(config => {
    if (host.peer && !host.peer.destroyed) host.peer.options.config = config;
    showRelayProblem();
  });
  connectToBroker();
  localAddressMode().then(mode => { host.lanMode = mode; showLanMode(); updateLanHint(); });

  await rescanFolder();
  setInterval(rescanFolder, FOLDER_RESCAN_MS);
  addEventListener('beforeunload', e => { if (host.sessions.size) e.preventDefault(); });
}
