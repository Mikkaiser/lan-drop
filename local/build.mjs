// Builds LAN Drop Local as one self-contained program for the platform this runs on
// (Node "single executable application": the Node runtime + server.js + the page's files).
//
//   node build.mjs          ->  dist/lan-drop-local-<os>-<arch>[.exe]
//
// Needs Node 20+ and network access once for `npx postject`. Run it on each OS you ship for
// (the GitHub Actions workflow does Windows, macOS and Linux).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
fs.mkdirSync(dist, { recursive: true });

const os = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform] || process.platform;
const exe = path.join(dist, `lan-drop-local-${os}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`);
const blob = path.join(dist, 'sea-prep.blob');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: here, shell: process.platform === 'win32' && cmd === 'npx' });

// Every file in public/ is embedded under its own name (server.js reads them with sea.getAsset).
const assets = Object.fromEntries(fs.readdirSync(path.join(here, 'public')).map(f => [f, path.join('public', f)]));
const config = path.join(dist, 'sea-config.json');
fs.writeFileSync(config, JSON.stringify({
  main: 'server.js', output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, assets,
}, null, 2));

console.log(`Building ${path.basename(exe)} with Node ${process.version}`);
run(process.execPath, ['--experimental-sea-config', config]);
fs.copyFileSync(process.execPath, exe);
if (process.platform === 'darwin') run('codesign', ['--remove-signature', exe]);
run('npx', ['--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
if (process.platform === 'darwin') run('codesign', ['--sign', '-', exe]);
if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
fs.rmSync(blob, { force: true });
fs.rmSync(config, { force: true });
console.log(`Done: ${exe} (${(fs.statSync(exe).size / 1048576).toFixed(0)} MB)`);
