// Popups: one helper gives every popup the same behaviour (close button, Esc, click outside,
// focus back to what opened it). This file also wires the two footer popups: the "How LAN Drop
// works" video and the "Download LAN Drop Local" panel. host.js adds the LAN help panel.

import { LOCAL_BUILDS, LOCAL_DOWNLOAD_BASE, VIDEO_SRC } from './config.js';
import { $, el } from './util.js';

const openModals = new Set();

/**
 * Make #id (a `.modal` with a close button #closeId) behave as a popup.
 * onOpen / onClose run as it opens and closes. Returns { open(trigger?), close() }.
 */
export function setupModal(id, { closeId, onOpen = () => {}, onClose = () => {} }) {
  const modal = $('#' + id);
  let trigger = null;
  const api = {
    open(from = document.activeElement) {
      trigger = from;
      onOpen();
      modal.hidden = false;
      openModals.add(api);
      $('#' + closeId).focus();
    },
    close() {
      if (modal.hidden) return;
      onClose();
      modal.hidden = true;
      openModals.delete(api);
      trigger?.focus?.();
    },
  };
  $('#' + closeId).onclick = api.close;
  modal.addEventListener('click', e => { if (e.target === modal) api.close(); }); // the dimmed area around it
  return api;
}

addEventListener('keydown', e => {
  if (e.key === 'Escape') for (const modal of [...openModals]) modal.close();
});

// ---------- "How LAN Drop works" video ----------

const video = $('#howVideo');
const howModal = setupModal('howModal', {
  closeId: 'howClose',
  onOpen() {
    if (!video.src) video.src = VIDEO_SRC; // downloaded only when someone opens it
    video.play().catch(() => {});          // autoplay with sound may be refused; the controls are there
  },
  onClose() { video.pause(); },
});
$('#howBtn').onclick = e => howModal.open(e.currentTarget);

// ---------- "Download LAN Drop Local" ----------

/** Which build to suggest. Browsers don't say which Mac chip; most current Macs are Apple Silicon. */
function suggestedBuild() {
  const platform = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  if (platform.includes('win')) return 'windows';
  if (platform.includes('mac')) return 'mac-arm64';
  if (platform.includes('linux') && !/android/i.test(navigator.userAgent)) return 'linux';
  return null;
}

const localModal = setupModal('localModal', {
  closeId: 'localClose',
  onOpen() {
    const pick = LOCAL_BUILDS.find(b => b.id === suggestedBuild());
    const primary = $('#localPrimary');
    primary.hidden = !pick;
    if (pick) {
      primary.href = LOCAL_DOWNLOAD_BASE + pick.file;
      primary.textContent = `Download for ${pick.label}`;
    }
    $('#localOthers').replaceChildren(...LOCAL_BUILDS.filter(b => b !== pick).map(b =>
      el('li', {}, el('span', { textContent: b.label }),
        el('a', { className: 'btn', href: LOCAL_DOWNLOAD_BASE + b.file, textContent: 'Download' }))));
  },
});
$('#localBtn').onclick = e => localModal.open(e.currentTarget);
