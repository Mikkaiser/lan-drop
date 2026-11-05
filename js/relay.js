// Relay passes: the ICE server list WebRTC uses (STUN always, plus Cloudflare TURN relay
// credentials from our Worker when we can get them).
//
// A pass is requested from all RELAY_URLS at once, with a Cloudflare Turnstile token so only
// real visitors of this page get one. Passes last 3 hours, so they're refreshed hourly; PeerJS
// reads `options.config` for every new connection, so subscribers swap the new list in.

import {
  RELAY_FETCH_TIMEOUT_MS, RELAY_REFRESH_MS, RELAY_RETRY_MS, RELAY_URLS, STUN_SERVERS, TURNSTILE_SITE_KEY,
} from './config.js';
import { hideToast, toast } from './util.js';

/** Current state; read these fields, don't assign them. */
export const relay = {
  config: { iceServers: STUN_SERVERS }, // what to give PeerJS
  publicIp: '',                          // this browser's public IP, as the Worker saw it
  problem: '',                           // why the relay is off (e.g. monthly limit reached), or ''
};

export const relayEnabled = RELAY_URLS.length > 0;
export const hasRelay = () => relay.config.iceServers.some(s => [].concat(s.urls).some(u => u.startsWith('turn')));

// ---------- Turnstile bot check ----------

let widget = null;     // Turnstile widget id, created on first use
let deliver = null;    // resolves the token request in progress
let giveUpTimer = null;

/** A fresh one-time Turnstile token, or '' if Turnstile is off, blocked or failed. */
async function turnstileToken() {
  if (!TURNSTILE_SITE_KEY) return '';
  // (Check for render(): a page element with id "turnstile" would also show up as window.turnstile.)
  const loaded = () => typeof window.turnstile?.render === 'function';
  for (let i = 0; !loaded() && i < 50; i++) await new Promise(r => setTimeout(r, 200));
  if (!loaded()) return ''; // script blocked: the Worker will refuse, direct connections still work

  return new Promise(resolve => {
    const finish = token => { clearTimeout(giveUpTimer); deliver = null; resolve(token || ''); };
    giveUpTimer = setTimeout(() => finish(''), 30000);
    deliver = finish;
    try { runTurnstile(); } catch (e) { console.warn('turnstile failed', e); finish(''); }
  });
}

function runTurnstile() {
  if (widget === null) {
    widget = window.turnstile.render('#ts-box', {
      sitekey: TURNSTILE_SITE_KEY,
      execution: 'execute',
      appearance: 'interaction-only', // invisible unless Turnstile insists on a click
      callback: token => { hideToast(); deliver?.(token); },
      'error-callback': () => { deliver?.(''); return true; },
      // Turnstile wants a click: wait for the person (no time limit) and tell them where.
      'before-interactive-callback': () => {
        clearTimeout(giveUpTimer);
        toast('Tick the box at the bottom right to enable the relay.', 0);
      },
    });
  } else {
    window.turnstile.reset(widget); // each token works once
  }
  window.turnstile.execute(widget);
}

// ---------- Fetching a pass ----------

async function fetchPass(url, headers) {
  const res = await fetch(url, { cache: 'no-store', headers, signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS) });
  const data = await res.json().catch(() => ({}));
  // `refused`: the Worker answered and said no (bot check failed, monthly limit), as opposed to unreachable.
  if (!res.ok) throw Object.assign(new Error(data.error || `relay error ${res.status}`), { refused: true });
  return data;
}

// Browsers time out on port 53 relay addresses, so those are dropped.
const usableServers = list => [].concat(list || [])
  .map(s => ({ ...s, urls: [].concat(s.urls).filter(u => !/:53(\?|$)/.test(u)) }))
  .filter(s => s.urls.length);

async function fetchConfig() {
  if (!relayEnabled) return relay.config;
  try {
    const token = await turnstileToken();
    // One token for every address, with one idempotency key, so whichever answers can verify it.
    const headers = token ? { 'X-Turnstile-Token': token, 'X-Turnstile-Key': crypto.randomUUID() } : {};
    let pass;
    try {
      pass = await Promise.any(RELAY_URLS.map(url => fetchPass(url, headers)));
    } catch (all) {
      const refused = all.errors.find(e => e.refused);
      if (refused) { relay.problem = refused.message; relay.config = { iceServers: STUN_SERVERS }; }
      throw refused || all.errors[0];
    }
    relay.problem = '';
    if (pass.ip) relay.publicIp = pass.ip;
    const servers = usableServers(pass.iceServers);
    if (servers.some(s => s.urls.some(u => u.startsWith('turn')))) relay.config = { iceServers: servers };
  } catch (e) {
    console.warn('relay unavailable, direct connections only', e);
  }
  return relay.config;
}

// One request at a time (start-up, the refresh and guest retries can overlap; they share Turnstile).
let inProgress = null;
export function refreshRelay() {
  return inProgress ||= fetchConfig().finally(() => { inProgress = null; });
}

/** Resolves once the first attempt at a pass has finished (with or without one). */
export const relayReady = refreshRelay();

// ---------- Keeping it fresh ----------

const subscribers = new Set();
/** fn(config) after every refresh; returns an unsubscribe function. */
export function onRelayRefresh(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

(function scheduleRefresh() {
  const delay = relayEnabled && !hasRelay() ? RELAY_RETRY_MS : RELAY_REFRESH_MS;
  setTimeout(() => refreshRelay()
    .then(config => { for (const fn of subscribers) fn(config); })
    .finally(scheduleRefresh), delay);
})();
