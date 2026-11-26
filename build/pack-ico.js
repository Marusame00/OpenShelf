// build/pack-ico.js — pack build/icon/<size>.png into a multi-size .ico.
// PNG-compressed entries are supported by Windows Vista and later, so no BMP
// encoding is needed. Zero dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const iconDir = path.join(here, 'icon');
const sizes = [16, 24, 32, 48, 64, 128, 256];

const images = sizes.map((s) => {
  const file = path.join(iconDir, `${s}.png`);
  const data = fs.readFileSync(file);
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  return { size: s, data };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

const entries = [];
let offset = 6 + images.length * 16;
for (const img of images) {
  const e = Buffer.alloc(16);
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
  e.writeUInt8(0, 2);
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(img.data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += img.data.length;
  entries.push(e);
}

const ico = Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
const out = path.join(here, 'icon.ico');
fs.writeFileSync(out, ico);
console.log(`wrote ${out} (${ico.length} bytes, ${images.length} sizes)`);
