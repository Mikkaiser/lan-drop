// LAN Drop Local — the offline version of LAN Drop.
// The host runs this on the computer whose folder is shared; everyone on the same network
// (a router with no internet, a phone hotspot, or a direct Ethernet cable) opens the address
// it prints in any browser. Files go straight between their browser and this computer over
// plain HTTP: no internet, no broker, no relay. No dependencies beyond Node itself.
//
//   lan-drop-local [--folder <path>] [--port <n>] [--no-open] [--choose]
//
// The folder is remembered in ~/.lan-drop-local.json; --choose asks again.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const readline = require('readline');

const VERSION = '1.0.0';
const CONFIG = path.join(os.homedir(), '.lan-drop-local.json');

// ---------- options ----------

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const flag = name => argv.includes(name);
let PORT = Number(arg('--port') || process.env.PORT) || 8080;

// ---------- the page's files: embedded in the single executable, or next to this script ----------

let sea = null;
try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch { sea = null; }

const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/qrcode.js': ['qrcode.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon-32.png': ['favicon-32.png', 'image/png'],
  '/favicon-180.png': ['favicon-180.png', 'image/png'],
  '/fonts/barlow-400.woff2': ['barlow-400.woff2', 'font/woff2'],
  '/fonts/barlow-600.woff2': ['barlow-600.woff2', 'font/woff2'],
  '/fonts/barlow-700.woff2': ['barlow-700.woff2', 'font/woff2'],
  '/fonts/barlow-900.woff2': ['barlow-900.woff2', 'font/woff2'],
  '/fonts/ibm-plex-mono-400.woff2': ['ibm-plex-mono-400.woff2', 'font/woff2'],
  '/fonts/ibm-plex-mono-500.woff2': ['ibm-plex-mono-500.woff2', 'font/woff2'],
};
const assetCache = new Map();
function asset(name) {
  if (!assetCache.has(name)) {
    assetCache.set(name, sea ? Buffer.from(sea.getAsset(name)) : fs.readFileSync(path.join(__dirname, 'public', name)));
  }
  return assetCache.get(name);
}

// Types safe to show in the browser; everything else downloads.
const INLINE = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8',
};

// ---------- the shared folder ----------

function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } }
function writeConfig(c) { try { fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2)); } catch { /* not fatal */ } }

// The system's own folder picker; resolves to a path, or null if cancelled / unavailable.
function pickFolder(start) {
  return new Promise(resolve => {
    const done = (err, out) => resolve(!err && out && out.trim() ? out.trim() : null);
    if (process.platform === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
        "$d.Description = 'LAN Drop Local: choose the folder to share';",
        '$d.ShowNewFolderButton = $true;',
        start ? `$d.SelectedPath = '${start.replace(/'/g, "''")}';` : '',
        '$f = New-Object System.Windows.Forms.Form; $f.TopMost = $true;',
        "if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
      ].join(' ');
      execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true }, done);
    } else if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "LAN Drop Local: choose the folder to share")'], done);
    } else {
      execFile('zenity', ['--file-selection', '--directory', '--title=LAN Drop Local: choose the folder to share'], (err, out) => {
        if (!err) return done(null, out);
        execFile('kdialog', ['--getexistingdirectory', start || os.homedir()], done);
      });
    }
  });
}

function askInTerminal(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim()); }));
}

async function chooseFolder(current) {
  const picked = await pickFolder(current);
  if (picked) return picked;
  if (!current) {
    const typed = await askInTerminal(`  Folder to share (Enter for ${path.join(os.homedir(), 'LAN Drop Shared')}): `);
    return typed || path.join(os.homedir(), 'LAN Drop Shared');
  }
  return null;
}

let DIR = null;
let watcher = null;

function useFolder(dir) {
  DIR = path.resolve(dir);
  fs.mkdirSync(DIR, { recursive: true });
  // Clean up partial uploads left over from a previous run.
  for (const f of fs.readdirSync(DIR)) {
    if (f.startsWith('.lan-drop-') && f.endsWith('.part')) fs.rmSync(path.join(DIR, f), { force: true });
  }
  writeConfig({ ...readConfig(), folder: DIR });
  watcher?.close();
  // Files added or removed in Explorer/Finder show up for everyone too.
  try { watcher = fs.watch(DIR, (_e, f) => { if (!f || !f.startsWith('.')) broadcastFiles(); }); } catch { watcher = null; }
  broadcastFiles();
  broadcastInfo();
}

// ---------- helpers ----------

function lanUrls() {
  const urls = [];
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|TAP|TUN|utun|docker|br-/i.test(ifname)) continue;
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
  }
  return urls;
}
const ownAddresses = () => new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map(a => a.address));
const clientIp = req => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
// The host is whoever opens the page on this computer (loopback, or one of its own addresses).
const isHost = req => { const ip = clientIp(req); return ip === '127.0.0.1' || ip === '::1' || ownAddresses().has(ip); };

function deviceLabel(ua = '') {
  const os_ = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os_} · ${browser}`;
}

function listFiles() {
  if (!DIR) return [];
  const out = [];
  for (const d of fs.readdirSync(DIR, { withFileTypes: true })) {
    if (!d.isFile() || d.name.startsWith('.')) continue;
    try {
      const st = fs.statSync(path.join(DIR, d.name));
      out.push({ name: d.name, size: st.size, mtime: st.mtimeMs });
    } catch { /* deleted mid-listing */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function safeName(raw) {
  let name = path.basename(String(raw).replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 200);
  if (!name) name = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = '_' + name;
  return name;
}

function uniqueName(name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 1; fs.existsSync(path.join(DIR, candidate)); i++) candidate = `${base} (${i})${ext}`;
  return candidate;
}

// Resolve /files/<name> to a real file directly inside DIR, or null.
function resolveFile(encoded) {
  let name;
  try { name = decodeURIComponent(encoded); } catch { return null; }
  if (!DIR || !name || name.startsWith('.') || /[\\/]/.test(name) || name !== path.basename(name)) return null;
  const full = path.join(DIR, name);
  try { const st = fs.statSync(full); return st.isFile() ? { name, full, st } : null; } catch { return null; }
}

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
const json = (res, status, data) => send(res, status, JSON.stringify(data), 'application/json');

function contentDisposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// ---------- live updates (Server-Sent Events) ----------

// res -> { ip, device, host, since }
const clients = new Map();

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }

let filesTimer = null;
function broadcastFiles() {
  clearTimeout(filesTimer);
  filesTimer = setTimeout(() => {
    const files = listFiles();
    for (const res of clients.keys()) sse(res, 'files', files);
  }, 150);
}

const infoFor = c => ({
  version: VERSION, hostname: os.hostname(), urls: lanUrls(), host: c.host,
  ...(c.host ? { folder: DIR } : {}),
});
function broadcastInfo() { for (const [res, c] of clients) sse(res, 'info', infoFor(c)); }

// Only the host sees who is connected (and from which address).
function broadcastPeople() {
  const people = [...clients.values()].filter(c => !c.host).map(c => ({ device: c.device, ip: c.ip, since: c.since }));
  for (const [res, c] of clients) if (c.host) sse(res, 'people', people);
}

setInterval(() => { for (const res of clients.keys()) res.write(': ping\n\n'); }, 20000);

// New Wi-Fi or a cable plugged in: the addresses change, so tell everyone.
let lastUrls = '';
setInterval(() => {
  const now = lanUrls().join();
  if (now !== lastUrls) { lastUrls = now; broadcastInfo(); if (server.listening) printBanner(); }
}, 3000);

// ---------- requests ----------

async function handleUpload(req, res) {
  let name;
  try { name = safeName(decodeURIComponent(req.headers['x-filename'] || '')); }
  catch { return send(res, 400, 'Bad filename'); }
  const tmp = path.join(DIR, `.lan-drop-${crypto.randomUUID()}.part`);
  const ws = fs.createWriteStream(tmp);
  try {
    await pipeline(req, ws);
  } catch {
    const cleanup = () => fs.rm(tmp, { force: true }, () => {});
    ws.closed ? cleanup() : ws.once('close', cleanup);
    if (!res.headersSent) send(res, 500, 'Upload failed');
    return;
  }
  const finalName = uniqueName(name);
  fs.renameSync(tmp, path.join(DIR, finalName));
  log(`received ${finalName} from ${clientIp(req)}`);
  json(res, 201, { name: finalName });
  broadcastFiles();
}

function handleDownload(req, res, file, url) {
  const ext = path.extname(file.name).toLowerCase();
  const inline = INLINE[ext] && url.searchParams.get('dl') !== '1';
  const headers = {
    'Content-Type': inline ? INLINE[ext] : 'application/octet-stream',
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', file.name),
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  // Single-range support so videos and audio can seek.
  const size = file.st.size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start); end = Math.min(end, size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file.full, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file.full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && ASSETS[p === '/index.html' ? '/' : p]) {
    const [name, type] = ASSETS[p === '/index.html' ? '/' : p];
    return send(res, 200, asset(name), type, { 'Cache-Control': name === 'index.html' || name === 'app.js' ? 'no-cache' : 'max-age=86400' });
  }

  if (req.method === 'GET' && p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const c = { ip: clientIp(req), device: deviceLabel(req.headers['user-agent']), host: isHost(req), since: Date.now() };
    clients.set(res, c);
    sse(res, 'info', infoFor(c));
    sse(res, 'files', listFiles());
    broadcastPeople();
    if (!c.host) log(`${c.device} connected from ${c.ip}`);
    req.on('close', () => { clients.delete(res); broadcastPeople(); if (!c.host) log(`${c.device} (${c.ip}) left`); });
    return;
  }

  if (req.method === 'POST' && p === '/upload') return void handleUpload(req, res);

  // Change the shared folder: only from the host computer, with its own folder picker.
  if (req.method === 'POST' && p === '/api/folder') {
    if (!isHost(req)) return send(res, 403, 'Only the host computer can change the folder');
    const picked = await pickFolder(DIR);
    if (!picked) return json(res, 200, { changed: false, folder: DIR });
    useFolder(picked);
    log(`now sharing ${DIR}`);
    return json(res, 200, { changed: true, folder: DIR });
  }

  if (p.startsWith('/files/')) {
    const file = resolveFile(p.slice('/files/'.length));
    if (!file) return send(res, 404, 'Not found');
    if (req.method === 'GET' || req.method === 'HEAD') return handleDownload(req, res, file, url);
    if (req.method === 'DELETE') {
      return fs.rm(file.full, { force: true }, err => {
        if (err) return send(res, 500, 'Delete failed');
        log(`deleted ${file.name} (by ${clientIp(req)})`);
        send(res, 204, '');
        broadcastFiles();
      });
    }
  }

  send(res, 404, 'Not found');
});
server.requestTimeout = 0; // large / slow uploads

// ---------- start ----------

const time = () => new Date().toLocaleTimeString();
function log(msg) { console.log(`  [${time()}] ${msg}`); }

function printBanner() {
  console.log(`\n  LAN Drop Local ${VERSION}: sharing ${DIR}\n`);
  console.log(`  On this computer:  http://localhost:${PORT}`);
  const urls = lanUrls();
  if (!urls.length) console.log('  On the network:    (not connected to a network yet)');
  for (const u of urls) console.log(`  On the network:    ${u}`);
  console.log('\n  Others on the same network, hotspot or cable open that address in any browser.');
  if (process.platform === 'win32') console.log('  If Windows asks, allow LAN Drop Local on private (and public) networks.');
  console.log('  Close this window or press Ctrl+C to stop sharing.\n');
}

function openBrowser(u) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]]
    : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* fine */ }
}

function listen(port, triesLeft = 10) {
  return new Promise((resolve, reject) => {
    const onError = err => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE' && triesLeft > 0) resolve(listen(port + 1, triesLeft - 1));
      else reject(err);
    };
    const onListening = () => { server.off('error', onError); PORT = port; resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}

(async () => {
  let folder = arg('--folder');
  if (!folder && !flag('--choose')) {
    const saved = readConfig().folder;
    if (saved && fs.existsSync(saved)) folder = saved;
  }
  if (!folder) {
    console.log('\n  LAN Drop Local: choose the folder to share…');
    folder = await chooseFolder(readConfig().folder);
  }
  useFolder(folder);
  await listen(PORT);
  lastUrls = lanUrls().join();
  printBanner();
  if (!flag('--no-open')) openBrowser(`http://localhost:${PORT}`);
})().catch(err => {
  console.error(`\n  LAN Drop Local could not start: ${err.message}\n`);
  process.exitCode = 1;
});
