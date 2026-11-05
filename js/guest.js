// Joining a share: connect to the host's code, show its files, download and upload.
//
// A guest opens one control connection (file list, requests). If the host speaks protocol v2,
// it adds LANES - 1 extra "lane" connections, and every transfer is split into segments spread
// over all of them (see protocol.js). Older hosts get the v1 single-stream transfers.

import {
  BIG_DOWNLOAD_BYTES, BROKER_PREFIX, CONNECT_TIMEOUT_MS, HEARTBEAT_MS, LANES, SEGMENT_BYTES, SEGMENTS_PER_LANE,
} from './config.js';
import { createSegmentScheduler, isFrameV2, sendJSON, sendRange, sendWholeFile, unframeV1, unframeV2 } from './protocol.js';
import { hasRelay, onRelayRefresh, refreshRelay, relay, relayEnabled, relayReady } from './relay.js';
import { chosenAddress, ROUTE_LABEL, routeOf } from './routes.js';
import { setBackend, setFiles, setNotice, setStatus, showApp } from './files-view.js';
import { $, deviceLabel, saveBlob, toast } from './util.js';

const guest = {
  code: null,
  peer: null,
  control: null,          // the control connection
  lanes: new Set(),       // extra connections for v2 transfers
  hostVersion: 0,         // protocol version the host announced (0 until its first file list)
  nextId: 1,
  transfers: new Map(),   // id -> transfer in progress; gets the host's messages for that id
  retryTimer: null,
};

/** The control connection's data channel, if it is open. */
function controlChannel() {
  const channel = guest.control?.dataChannel;
  return channel && channel.readyState === 'open' ? channel : null;
}
/** Every connection that can carry v2 segments right now. */
function openLanes() {
  return [guest.control, ...guest.lanes].filter(conn => conn?.dataChannel?.readyState === 'open');
}

/** Add a transfer that the host's messages for `id` go to; returns a function that removes it. */
function track(id, transfer) {
  guest.transfers.set(id, transfer);
  return () => guest.transfers.delete(id);
}
/** Lanes came or went: let every v2 transfer re-plan. */
function forEachStriped(fn) {
  for (const transfer of guest.transfers.values()) if (transfer.striped) fn(transfer);
}

// ---------- Lanes ----------

function openLane() {
  const { peer, control } = guest;
  if (!peer || peer.destroyed || peer.disconnected || !control?.open) return;
  const lane = peer.connect(BROKER_PREFIX + guest.code, { serialization: 'raw', reliable: true, metadata: { role: 'lane' } });
  lane.on('open', () => {
    if (guest.control !== control) return lane.close(); // we reconnected meanwhile
    guest.lanes.add(lane);
    forEachStriped(t => t.fill());
  });
  lane.on('data', data => onHostData(data, lane));
  lane.on('close', () => {
    if (!guest.lanes.delete(lane)) return;
    forEachStriped(t => t.laneLost(lane));
    setTimeout(() => {
      if (guest.control === control && control.open && guest.lanes.size < LANES - 1) openLane();
    }, 3000);
  });
  lane.on('error', () => {});
}

// ---------- v2 transfers: segments over every lane ----------

/** Download `file` into `sink`, asking each lane for its own segments. */
function stripedDownload(file, row, sink) {
  return new Promise(resolve => {
    const id = guest.nextId++;
    let received = 0;
    let writes = Promise.resolve();
    let scheduler = null;

    const transfer = {
      striped: true,
      meta({ size }) {
        if (!size) return transfer.complete();
        scheduler = createSegmentScheduler(size, SEGMENTS_PER_LANE, openLanes,
          (index, lane, start, end) => sendJSON(lane.dataChannel, { t: 'range', id, name: file.name, start, end }));
        row.progress(0);
        scheduler.fill();
      },
      bytes(offset, bytes, lane) {
        const index = Math.floor(offset / SEGMENT_BYTES);
        const segment = scheduler?.ownerOf(index);
        if (!segment || segment.lane !== lane) return; // late data for a segment that moved to another lane
        segment.got += bytes.byteLength;
        received += bytes.byteLength;
        row.progress(received);
        writes = writes.then(() => sink.write(offset, bytes));
        if (segment.got >= scheduler.segmentLength(index) && scheduler.finish(index)) transfer.complete();
      },
      fill() { scheduler?.fill(); },
      laneLost(lane) { scheduler?.laneLost(lane); },
      complete() {
        untrack();
        writes.then(() => sink.close()).then(() => row.done(), e => row.fail(e.message)).finally(resolve);
      },
      err(message) {
        untrack();
        writes.finally(() => sink.abort());
        row.fail(message);
        resolve();
      },
    };
    const untrack = track(id, transfer);
    row.note('starting…');
    sendJSON(controlChannel(), { t: 'stat', id, name: file.name });
  });
}

/** Upload `file`: each lane sends a segment, waits for the host's ack, then takes the next. */
function stripedUpload(file, row) {
  return new Promise(resolve => {
    const channel = controlChannel();
    if (!channel) { row.fail('not connected'); return resolve(); }
    const id = guest.nextId++;
    let sent = 0;
    let scheduler = null;

    const transfer = {
      striped: true,
      ready() {
        scheduler = createSegmentScheduler(file.size, SEGMENTS_PER_LANE, openLanes, (index, lane, start, end) =>
          sendRange(lane.dataChannel, id, file, start, end,
            // Stop if the upload ended, or this segment was handed to another lane.
            () => !guest.transfers.has(id) || scheduler.ownerOf(index)?.lane !== lane,
            n => { sent += n; row.progress(Math.min(sent, file.size)); }));
        scheduler.fill();
      },
      ack({ seg }, lane) {
        const segment = scheduler?.ownerOf(seg);
        if (segment && segment.lane === lane && scheduler.finish(seg)) row.note('saving…');
      },
      fill() { scheduler?.fill(); },
      laneLost(lane) { scheduler?.laneLost(lane); },
      saved({ name }) { untrack(); row.done(name === file.name ? 'done' : 'saved as ' + name); resolve(); },
      err(message) { untrack(); row.fail(message); resolve(); },
    };
    const untrack = track(id, transfer);
    sendJSON(channel, { t: 'put2', id, name: file.name, size: file.size, seg: SEGMENT_BYTES });
  });
}

// ---------- v1 transfers (hosts on an older cached page) ----------

/** Upload as one stream on the control connection. */
function legacyUpload(file, row) {
  return new Promise(resolve => {
    const channel = controlChannel();
    if (!channel) { row.fail('not connected'); return resolve(); }
    const id = guest.nextId++;
    const untrack = track(id, {
      async ready() {
        const finished = await sendWholeFile(channel, id, file, () => !guest.transfers.has(id), n => row.progress(n));
        if (finished) row.note('saving…');
      },
      saved({ name }) { untrack(); row.done(name === file.name ? 'done' : 'saved as ' + name); resolve(); },
      err(message) { untrack(); row.fail(message); resolve(); },
    });
    sendJSON(channel, { t: 'put', id, name: file.name, size: file.size });
  });
}

/** Download as one in-order stream on the control connection. */
function legacyDownload(file, row, sink) {
  const channel = controlChannel();
  if (!channel) return row.fail('not connected');
  const id = guest.nextId++;
  let offset = 0;
  let writes = Promise.resolve();
  const untrack = track(id, {
    meta() {},
    bytes(_offset, bytes) {
      const at = offset;
      offset += bytes.byteLength;
      writes = writes.then(() => sink.write(at, bytes));
      row.progress(offset);
    },
    end() {
      untrack();
      writes.then(() => sink.close()).then(() => row.done(), e => row.fail(e.message));
    },
    err(message) { untrack(); writes.finally(() => sink.abort()); row.fail(message); },
  });
  row.note('starting…');
  sendJSON(channel, { t: 'get', id, name: file.name });
}

/**
 * Where a download is written: straight to disk for big files where the browser allows it
 * (desktop Chrome/Edge), otherwise memory. null if the person cancelled the save dialog.
 * Returns { write(offset, bytes), close(), abort() }.
 */
async function downloadSink(file) {
  if (file.size > BIG_DOWNLOAD_BYTES && window.showSaveFilePicker) {
    try {
      const writable = await (await window.showSaveFilePicker({ suggestedName: file.name })).createWritable();
      return {
        write: (offset, bytes) => writable.write({ type: 'write', position: offset, data: bytes }),
        close: () => writable.close(),
        abort: () => writable.abort(),
      };
    } catch (e) {
      if (e.name === 'AbortError') return null;
      // any other failure: fall back to memory
    }
  }
  // Keyed by offset: a segment re-sent on another lane replaces what the lost lane delivered.
  const parts = new Map();
  return {
    write: (offset, bytes) => { parts.set(offset, bytes); },
    close: () => saveBlob(new Blob([...parts.keys()].sort((a, b) => a - b).map(k => parts.get(k))), file.name),
    abort: () => { parts.clear(); },
  };
}

// ---------- Messages from the host ----------

function onHostData(data, conn) {
  if (typeof data !== 'string') {
    if (isFrameV2(data)) {
      const [id, offset, bytes] = unframeV2(data);
      guest.transfers.get(id)?.bytes?.(offset, bytes, conn);
    } else {
      const [id, bytes] = unframeV1(data);
      guest.transfers.get(id)?.bytes?.(null, bytes, conn);
    }
    return;
  }
  let message;
  try { message = JSON.parse(data); } catch { return; }

  if (message.t === 'files') {
    // A v2 host: open the extra lanes, once per control connection.
    if (conn === guest.control && message.v >= 2 && !guest.hostVersion) {
      guest.hostVersion = message.v;
      for (let i = 1; i < LANES; i++) openLane();
    }
    return setFiles(message.files);
  }
  const transfer = guest.transfers.get(message.id);
  if (!transfer) return;
  if (message.t === 'err') transfer.err(message.msg);
  else transfer[message.t]?.(message, conn);
}

// ---------- Connecting ----------

function retryConnect(delay = 4000) {
  clearTimeout(guest.retryTimer);
  guest.retryTimer = setTimeout(connectToHost, delay);
}

async function connectToHost() {
  const { peer } = guest;
  if (!peer || peer.destroyed) return;
  if (peer.disconnected) { peer.reconnect(); return; } // 'open' fires again and calls us back
  // No relay yet (e.g. the Worker was unreachable): try again before each attempt.
  if (relayEnabled && !hasRelay()) peer.options.config = await refreshRelay();

  guest.control?.close();
  for (const lane of guest.lanes) lane.close();
  guest.lanes.clear();
  guest.hostVersion = 0;
  const conn = guest.control = peer.connect(BROKER_PREFIX + guest.code, { serialization: 'raw', reliable: true });

  // The host was found but no route worked (direct blocked, and no relay or the relay failed).
  const unreachable = () => {
    if (conn.open || guest.control !== conn) return;
    clearTimeout(openTimeout);
    setStatus("Can't reach the host · retrying…", false);
    setNotice(hasRelay()
      ? 'Found the host but could not connect, even through the relay. Check that both devices have internet access. This page keeps trying.'
      : `Found the host, but this network blocks direct connections between devices and the relay is off${relay.problem ? ` (${relay.problem})` : ''}. Try a different network, for example a phone hotspot. This page keeps trying.`);
    conn.close();
    retryConnect(5000);
  };
  const openTimeout = setTimeout(unreachable, CONNECT_TIMEOUT_MS);
  conn.peerConnection?.addEventListener('iceconnectionstatechange', () => {
    if (conn.peerConnection.iceConnectionState === 'failed') unreachable();
  });

  conn.on('open', () => {
    clearTimeout(openTimeout);
    setStatus('Connected', true);
    setNotice('');
    sendJSON(conn.dataChannel, { t: 'hello', device: deviceLabel(), ip: relay.publicIp });
    // Show which route we ended up on (it can change in the first seconds, so look twice).
    const showRoute = () => chosenAddress(conn).then(address => {
      const route = routeOf(address);
      if (route && guest.control === conn && conn.open) setStatus(`Connected · ${ROUTE_LABEL[route]}`, true);
    }).catch(() => {});
    showRoute();
    setTimeout(showRoute, 3000);
  });
  conn.on('data', data => onHostData(data, conn));
  conn.on('close', () => {
    clearTimeout(openTimeout);
    if (guest.control !== conn) return;
    setStatus('Lost connection · retrying…', false);
    for (const lane of guest.lanes) lane.close();
    guest.lanes.clear();
    for (const transfer of [...guest.transfers.values()]) transfer.err('connection lost');
    guest.transfers.clear();
    retryConnect();
  });
  conn.on('error', () => {});
}

// ---------- Start ----------

/** What "Download", uploads and "Delete" mean for a guest: ask the host. */
const guestBackend = {
  openLabel: 'Download',
  async open(file, row) {
    if (!controlChannel()) return row.fail('not connected');
    const sink = await downloadSink(file);
    if (!sink) return row.fail('cancelled');
    return guest.hostVersion >= 2 ? stripedDownload(file, row, sink) : legacyDownload(file, row, sink);
  },
  upload(file, row) {
    return guest.hostVersion >= 2 ? stripedUpload(file, row) : legacyUpload(file, row);
  },
  remove(name) {
    const channel = controlChannel();
    if (!channel) return toast('Not connected');
    sendJSON(channel, { t: 'del', name });
  },
};

/** Join the share with this code. */
export async function startGuest(code) {
  guest.code = code;
  $('#title').textContent = 'Share ' + code;
  setStatus('Connecting…', false);
  // Tell the host we're still here, and say goodbye when the page closes, so its list of
  // connected people stays accurate.
  setInterval(() => sendJSON(controlChannel(), { t: 'ping' }), HEARTBEAT_MS);
  addEventListener('pagehide', () => sendJSON(controlChannel(), { t: 'bye' }));

  setBackend(guestBackend);
  showApp();

  await relayReady;
  const peer = guest.peer = new window.Peer({ config: relay.config });
  onRelayRefresh(config => { if (!peer.destroyed) peer.options.config = config; });
  peer.on('open', () => connectToHost());
  peer.on('disconnected', () => { setStatus('Offline · reconnecting…', false); retryConnect(3000); });
  peer.on('error', e => {
    if (e.type === 'peer-unavailable') {
      setStatus('Host not online · retrying…', false);
      setNotice(`No one is sharing with code ${guest.code} right now. Check the code, or ask the host to open their LAN Drop tab. This page keeps trying.`);
      retryConnect();
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
      setStatus('Offline · reconnecting…', false);
      retryConnect(5000);
    } else {
      console.warn('peer error', e.type, e);
    }
  });
}
