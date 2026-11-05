// Entry point. Decides what this page is:
//   - a link with a code (#ABC123)       -> join that share as a guest
//   - your own link, with a saved folder -> resume hosting it
//   - otherwise                          -> the start screen: share a folder, or type a code

import { STORAGE_CODE_KEY } from './config.js';
import { startGuest } from './guest.js';
import { startHosting } from './host.js';
import './modals.js'; // footer popups
import { $, cleanCode, savedFolder, settings, toast } from './util.js';

const canHost = !!window.showDirectoryPicker; // desktop Chrome and Edge

async function pickFolder() {
  try {
    startHosting(await window.showDirectoryPicker({ id: 'landrop', mode: 'readwrite' }));
  } catch (e) {
    if (e.name !== 'AbortError') toast('Could not use that folder: ' + e.message);
  }
}

/** A folder shared before: resume right away if the browser still allows it, else offer a button. */
async function offerResume(folder, myCode) {
  // Chrome may remember the permission ("Allow on every visit").
  if (await folder.queryPermission({ mode: 'readwrite' }).catch(() => 'denied') === 'granted') {
    startHosting(folder);
    return;
  }
  // Make resuming the obvious next step.
  const resume = $('#resumeBtn');
  resume.textContent = `Resume sharing "${folder.name}"`;
  resume.className = 'btn primary';
  resume.hidden = false;
  $('#pickBtn').className = 'btn';
  $('#pickBtn').textContent = 'Choose a different folder…';

  const note = $('#resumeNote');
  note.textContent = `Your share${myCode ? ` (code ${myCode})` : ''} is offline until you click Resume sharing. People who have your link can't connect until then.`;
  note.hidden = false;

  resume.onclick = async () => {
    try {
      const allowed = await folder.queryPermission({ mode: 'readwrite' }) === 'granted'
        || await folder.requestPermission({ mode: 'readwrite' }) === 'granted';
      if (allowed) startHosting(folder);
      else toast('Permission was not given for that folder.');
    } catch {
      toast('That folder is no longer available. Choose it again.');
    }
  };
}

async function start() {
  const code = cleanCode(location.hash.slice(1));
  const myCode = settings.get(STORAGE_CODE_KEY);
  const saved = canHost ? await savedFolder.load() : null;

  // Opening your own share link means "resume hosting", not "join it as a guest".
  if (code && !(saved && code === myCode)) return startGuest(code);
  if (code) history.replaceState(null, '', location.pathname);

  if (!canHost) {
    $('#pickBtn').disabled = true;
    $('#noPicker').hidden = false;
  } else {
    $('#pickBtn').onclick = pickFolder;
    if (saved) await offerResume(saved, myCode);
  }

  $('#joinForm').onsubmit = e => {
    e.preventDefault();
    const typed = cleanCode($('#code').value);
    if (typed.length < 4) return toast('Enter the code from the host’s screen.');
    location.hash = typed;
  };
}

addEventListener('hashchange', () => location.reload());
start();
