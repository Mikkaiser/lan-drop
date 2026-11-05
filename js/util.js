// Small helpers used everywhere: DOM, formatting, the toast, file names, saved settings.

import { CODE_ALPHABET, CODE_LENGTH } from './config.js';

// ---------- DOM ----------

export const $ = selector => document.querySelector(selector);

/** Create an element with properties and children: el('li', { className: 'x' }, 'text', child). */
export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

let toastTimer;
/** Show a short message at the bottom of the page; ms = 0 keeps it until hideToast(). */
export function toast(message, ms = 2800) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => box.classList.remove('show'), ms);
}
export function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').classList.remove('show');
}

export function copyToClipboard(text, doneMessage = 'Copied') {
  navigator.clipboard?.writeText(text).then(() => toast(doneMessage), () => toast(text));
}

// ---------- Formatting ----------

/** 1536 -> "1.5 KB" */
export function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return (i ? bytes.toFixed(bytes < 10 ? 1 : 0) : bytes) + ' ' + units[i];
}

/** A timestamp as "just now", "5 min ago", "3 h ago" or a date. */
export function timeAgo(ms) {
  const seconds = (Date.now() - ms) / 1000;
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
  if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago';
  return new Date(ms).toLocaleDateString();
}

/** "iPhone · Safari"-style label, so the host can tell devices apart. */
export function deviceLabel(ua = navigator.userAgent) {
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${browser}`;
}

// ---------- Files and codes ----------

/** A file name that is safe to create on Windows, macOS and Linux. */
export function safeName(raw) {
  let name = String(raw).split(/[\\/]/).pop()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 200);
  if (!name) name = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = '_' + name; // reserved on Windows
  return name;
}

/** The first characters of a file's extension, for its thumbnail ("zip", "pdf"…). */
export const extensionLabel = name => (name.match(/\.([^.]+)$/) || [, ''])[1].slice(0, 4) || 'file';

/** Hand a Blob to the browser as a download. */
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  el('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function newShareCode() {
  return [...crypto.getRandomValues(new Uint8Array(CODE_LENGTH))]
    .map(n => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
}
export const shareLink = code => location.origin + location.pathname + '#' + code;
/** Only letters and digits, upper-cased: what a typed or linked code is compared as. */
export const cleanCode = text => String(text).replace(/[^a-z0-9]/gi, '').toUpperCase();

// ---------- Saved in the browser ----------

/** localStorage that never throws (private windows can refuse it). */
export const settings = {
  get: key => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* not saved */ } },
  remove: key => { try { localStorage.removeItem(key); } catch { /* fine */ } },
};

// The host's folder handle is kept in IndexedDB (localStorage can't hold it).
function withStore(mode, use) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('landrop', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const request = use(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
export const savedFolder = {
  save: handle => withStore('readwrite', s => s.put(handle, 'dir')).catch(() => {}),
  load: () => withStore('readonly', s => s.get('dir')).catch(() => null),
  clear: () => withStore('readwrite', s => s.delete('dir')).catch(() => {}),
};
