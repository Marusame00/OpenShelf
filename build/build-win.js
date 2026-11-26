// build/build-win.js — assemble the Windows portable folder and its zip.
//
// Copies the app plus OpenShelf.exe (tray launcher) and node.exe into
// dist/OpenShelf-portable, then zips it. No npm packages, no bundler.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from './zip.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const dist = path.join(root, 'dist');
const outDir = path.join(dist, 'OpenShelf-portable');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const APP_FILES = ['server.js', 'package.json', 'LICENSE', 'README.md', 'openshelf.config.example.json'];
const APP_DIRS = ['src', 'public', 'docs'];

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else copyFile(s, d);
  }
}

rmrf(outDir);
fs.mkdirSync(outDir, { recursive: true });

for (const f of APP_FILES) copyFile(path.join(root, f), path.join(outDir, f));
for (const d of APP_DIRS) copyDir(path.join(root, d), path.join(outDir, d));

copyFile(path.join(here, 'out', 'OpenShelf.exe'), path.join(outDir, 'OpenShelf.exe'));
copyFile(path.join(here, 'icon.ico'), path.join(outDir, 'icon.ico'));
copyFile(process.execPath, path.join(outDir, 'node.exe'));

const zip = path.join(dist, `OpenShelf-${pkg.version}-portable-win-x64.zip`);
rmrf(zip);
const { entries } = writeZip(outDir, zip);

const mb = (p) => (fs.statSync(p).size / 1048576).toFixed(1) + ' MB';
console.log(`portable folder: ${outDir}`);
console.log(`zip: ${zip} (${mb(zip)}, ${entries} entries)`);
