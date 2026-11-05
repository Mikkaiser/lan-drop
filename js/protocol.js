// The wire format between a guest and the host, over PeerJS data connections ("raw" mode:
// strings are JSON messages, ArrayBuffers are file data).
//
// Connections: a guest opens one control connection, then (if the host speaks v2) LANES - 1
// extra "lane" connections, marked with metadata { role: 'lane' }. Lanes carry only file data.
//
// JSON messages, guest -> host
//   hello   { device, ip }                  who the guest is (shown in the host's list)
//   ping    {}                              heartbeat, every HEARTBEAT_MS
//   bye     {}                              the guest's page is closing
//   stat    { id, name }                    v2 download: how big is this file?
//   range   { id, name, start, end }        v2 download: send these bytes (on any lane)
//   put2    { id, name, size, seg }         v2 upload: about to send this file in segments
//   get     { id, name }                    v1 download: send the whole file in order
//   put     { id, name, size }              v1 upload
//   del     { name }                        delete a file for everyone
//   cancel  { id }                          stop a transfer
//
// JSON messages, host -> guest
//   files   { files: [{name,size,mtime}], v }   the folder's contents; v = protocol version
//   meta    { id, size }                    answer to stat / get
//   ready   { id }                          answer to put / put2: start sending
//   ack     { id, seg }                     v2 upload: segment `seg` arrived complete (on its lane)
//   saved   { id, name }                    upload finished, stored as `name`
//   end     { id }                          v1 download finished
//   err     { id, msg }                     the transfer failed
//
// Binary frames
//   v1: [id u32][bytes]                     in order, on the control connection
//   v2: [id | 0x80000000 u32][offset f64][bytes]   any order, any lane
// The high bit of the id tells them apart; v1 is still understood for older cached pages.

import { BLOCK_BYTES, CHUNK_BYTES, HIGH_WATER_BYTES, SEGMENT_BYTES } from './config.js';

const V2_FLAG = 0x80000000;

// ---------- Frames ----------

export function frameV1(id, bytes) {
  const out = new Uint8Array(4 + bytes.byteLength);
  new DataView(out.buffer).setUint32(0, id);
  out.set(bytes, 4);
  return out.buffer;
}
/** -> [id, bytes] */
export const unframeV1 = buf => [new DataView(buf).getUint32(0), new Uint8Array(buf, 4)];

export function frameV2(id, offset, bytes) {
  const out = new Uint8Array(12 + bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, (id | V2_FLAG) >>> 0);
  view.setFloat64(4, offset);
  out.set(bytes, 12);
  return out.buffer;
}
/** -> [id, offset, bytes] */
export function unframeV2(buf) {
  const view = new DataView(buf);
  return [view.getUint32(0) & 0x7fffffff, view.getFloat64(4), new Uint8Array(buf, 12)];
}
export const isFrameV2 = buf => buf.byteLength >= 12 && new DataView(buf).getUint32(0) >= V2_FLAG;

// ---------- Sending ----------

/** Send a JSON message if the channel is open (silently drops it otherwise). */
export function sendJSON(channel, message) {
  if (channel && channel.readyState === 'open') channel.send(JSON.stringify(message));
}

/** Wait until the channel has room, so big files don't pile up in memory. */
function waitForRoom(channel) {
  if (channel.bufferedAmount < HIGH_WATER_BYTES || channel.readyState !== 'open') return Promise.resolve();
  channel.bufferedAmountLowThreshold = HIGH_WATER_BYTES / 2;
  return new Promise(resolve => {
    const done = () => {
      channel.removeEventListener('bufferedamountlow', done);
      channel.removeEventListener('close', done);
      resolve();
    };
    channel.addEventListener('bufferedamountlow', done);
    channel.addEventListener('close', done);
  });
}

/**
 * Send bytes [start, end) of a Blob/File as frames made by makeFrame(offset, bytes).
 * Reads BLOCK_BYTES from disk at a time, sends CHUNK_BYTES per message.
 * onBlock(bytesInBlock) after each block. Returns false if cancelled or the channel closed.
 */
async function sendSlice(channel, blob, start, end, makeFrame, isCancelled, onBlock) {
  for (let offset = start; offset < end; offset += BLOCK_BYTES) {
    const bytes = new Uint8Array(await blob.slice(offset, Math.min(offset + BLOCK_BYTES, end)).arrayBuffer());
    for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
      await waitForRoom(channel);
      if (channel.readyState !== 'open' || isCancelled()) return false;
      channel.send(makeFrame(offset + i, bytes.subarray(i, i + CHUNK_BYTES)));
    }
    onBlock(bytes.length);
  }
  return true;
}

/** v1: a whole file, in order. onProgress(totalBytesSent). */
export function sendWholeFile(channel, id, blob, isCancelled = () => false, onProgress = () => {}) {
  let sent = 0;
  return sendSlice(channel, blob, 0, blob.size, (_offset, bytes) => frameV1(id, bytes), isCancelled,
    n => { sent += n; onProgress(sent); });
}

/** v2: one range of a file, each frame carrying its offset. onBlock(bytesInBlock). */
export function sendRange(channel, id, blob, start, end, isCancelled = () => false, onBlock = () => {}) {
  return sendSlice(channel, blob, start, end, (offset, bytes) => frameV2(id, offset, bytes), isCancelled, onBlock);
}

// ---------- Spreading a transfer over lanes (v2, guest side) ----------

/**
 * Hands out the SEGMENT_BYTES segments of a `size`-byte transfer to the open lanes, keeping up
 * to `perLane` segments in flight on each. If a lane drops, its unfinished segments go back in
 * the queue for the others.
 *
 *   getLanes()                    the connections open right now
 *   startSegment(index, lane, from, to)   begin sending / requesting one segment on that lane
 *
 * Returns { segmentLength(i), ownerOf(i), fill(), finish(i) -> allDone, laneLost(lane) }.
 */
export function createSegmentScheduler(size, perLane, getLanes, startSegment) {
  const count = Math.ceil(size / SEGMENT_BYTES);
  const waiting = [...Array(count).keys()];
  const inFlight = new Map(); // segment index -> { lane, got }
  const perLaneLoad = new Map();
  let finished = 0;

  const scheduler = {
    segmentLength: index => Math.min(SEGMENT_BYTES, size - index * SEGMENT_BYTES),
    ownerOf: index => inFlight.get(index),

    /** Give every lane with room another waiting segment. */
    fill() {
      for (const lane of getLanes()) {
        while ((perLaneLoad.get(lane) || 0) < perLane && waiting.length) {
          const index = waiting.shift();
          inFlight.set(index, { lane, got: 0 });
          perLaneLoad.set(lane, (perLaneLoad.get(lane) || 0) + 1);
          const from = index * SEGMENT_BYTES;
          startSegment(index, lane, from, from + scheduler.segmentLength(index));
        }
      }
    },

    /** Segment `index` is complete; returns true once every segment is. */
    finish(index) {
      const segment = inFlight.get(index);
      if (!segment) return false;
      inFlight.delete(index);
      perLaneLoad.set(segment.lane, perLaneLoad.get(segment.lane) - 1);
      finished++;
      if (finished < count) scheduler.fill();
      return finished === count;
    },

    laneLost(lane) {
      for (const [index, segment] of inFlight) {
        if (segment.lane === lane) { inFlight.delete(index); waiting.unshift(index); }
      }
      perLaneLoad.delete(lane);
      scheduler.fill();
    },
  };
  return scheduler;
}
