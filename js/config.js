// Settings for the whole site, in one place.

// ---------- Relay (see worker/ and relay-proxy/) ----------

// Three addresses for the same relay Worker, all tried at once. Some networks block the
// Cloudflare addresses *.workers.dev and *.pages.dev resolve to; the custom domain gets
// addresses those networks can reach. An empty list means direct connections only.
export const RELAY_URLS = [
  'https://relay.mikkaiser.com',
  'https://lan-drop-relay.pages.dev',
  'https://lan-drop-turn.mikkaiser-ribeiro.workers.dev',
];

// Public STUN servers: they tell each browser its public address, for direct connections.
export const STUN_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];

// Relay credentials last 3 hours; fetch fresh ones well before that. Until a relay is
// available at all, keep trying more often.
export const RELAY_REFRESH_MS = 60 * 60 * 1000;
export const RELAY_RETRY_MS = 60 * 1000;
export const RELAY_FETCH_TIMEOUT_MS = 8000;

// Cloudflare Turnstile bot check; the site key is public by design. '' turns the check off.
export const TURNSTILE_SITE_KEY = '0x4AAAAAAFx1HtOZSw2llBgp';

// ---------- Connection broker (PeerJS) ----------

// Share codes are registered on the public broker as `landrop-<CODE>`, apart from other apps.
export const BROKER_PREFIX = 'landrop-';
// 6-character codes without look-alike characters (no 0/O, 1/I).
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

// ---------- Transfers ----------

export const CHUNK_BYTES = 64 * 1024;             // one WebRTC message
export const BLOCK_BYTES = 1024 * 1024;           // one disk read
export const HIGH_WATER_BYTES = 4 * 1024 * 1024;  // pause sending while this much is still buffered
export const BIG_DOWNLOAD_BYTES = 200 * 1024 * 1024; // above this, stream to disk (if the browser can)
export const MAX_PARALLEL_UPLOADS = 3;

// Protocol v2: each guest opens LANES connections and transfers travel as SEGMENT_BYTES pieces,
// SEGMENTS_PER_LANE at a time on each (see protocol.js).
export const PROTOCOL_VERSION = 2;
export const LANES = 4;
export const SEGMENT_BYTES = 4 * 1024 * 1024;
export const SEGMENTS_PER_LANE = 2;

// ---------- Timings ----------

export const FOLDER_RESCAN_MS = 2000;         // host: re-read the folder (catches edits in Explorer/Finder)
export const HEARTBEAT_MS = 10 * 1000;        // guest: "still here" message
export const GUEST_TIMEOUT_MS = 75 * 1000;    // host: drop a guest silent for this long (backstop)
export const DISCONNECT_GRACE_MS = 6000;      // host: a "disconnected" connection may still recover
export const CONNECT_TIMEOUT_MS = 20 * 1000;  // guest: give up on one connection attempt

// ---------- Saved in the browser ----------

export const STORAGE_CODE_KEY = 'landrop-code'; // localStorage: the host's share code

// ---------- Footer ----------

export const VIDEO_SRC = 'how-lan-drop-works.mp4';

export const LOCAL_DOWNLOAD_BASE = 'https://github.com/Mikkaiser/lan-drop/releases/latest/download/';
export const LOCAL_BUILDS = [
  { id: 'windows', label: 'Windows', file: 'lan-drop-local-windows-x64.exe' },
  { id: 'mac-arm64', label: 'Mac with Apple Silicon (M1 and later)', file: 'lan-drop-local-mac-arm64.zip' },
  { id: 'mac-x64', label: 'Mac with Intel', file: 'lan-drop-local-mac-x64.zip' },
  { id: 'linux', label: 'Linux', file: 'lan-drop-local-linux-x64.tar.gz' },
];
