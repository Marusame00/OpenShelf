// src/thumbs.js — on-disk JPEG thumbnail cache for DLNA clients.
//
// No npm dependencies: resizing shells out to the OS (Windows PowerShell +
// System.Drawing, or ImageMagick on other platforms when installed). Originals
// are never modified; thumbnails live in <dataDir>/thumbs keyed by
// path + mtime + size + variant, so edits invalidate them automatically.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export const THUMB_VARIANTS = {
  tn: { max: 160, profile: 'JPEG_TN' },
  sm: { max: 640, profile: 'JPEG_SM' },
};

export const THUMB_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp']);

const PS_SCRIPT = [
  'Add-Type -AssemblyName System.Drawing',
  '$img = [System.Drawing.Image]::FromFile($env:OSH_IN)',
  'try {',
  '  if ($img.PropertyIdList -contains 0x0112) {',
  '    $o = $img.GetPropertyItem(0x0112).Value[0]',
  '    if ($o -eq 3) { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }',
  '    elseif ($o -eq 6) { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }',
  '    elseif ($o -eq 8) { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }',
  '  }',
  '  $m = [double]$env:OSH_MAX',
  '  $s = [Math]::Min(1.0, $m / [Math]::Max($img.Width, $img.Height))',
  '  $w = [Math]::Max(1, [int]($img.Width * $s))',
  '  $h = [Math]::Max(1, [int]($img.Height * $s))',
  '  $bmp = New-Object System.Drawing.Bitmap($w, $h)',
  '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
  '  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
  '  $g.Clear([System.Drawing.Color]::White)',
  '  $g.DrawImage($img, 0, 0, $w, $h)',
  '  $bmp.Save($env:OSH_OUT, [System.Drawing.Imaging.ImageFormat]::Jpeg)',
  '  $g.Dispose(); $bmp.Dispose()',
  '} finally { $img.Dispose() }',
].join('\n');

const PS_ENCODED = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');

export function createThumbs({ dir, concurrency = 2, log = console }) {
  const inflight = new Map();
  const queue = [];
  let active = 0;
  let mkdirDone = null;

  function run(job) {
    return new Promise((resolve, reject) => {
      queue.push({ job, resolve, reject });
      pump();
    });
  }

  function pump() {
    while (active < concurrency && queue.length) {
      const { job, resolve, reject } = queue.shift();
      active++;
      job().then(resolve, reject).finally(() => { active--; pump(); });
    }
  }

  function convert(src, out, max) {
    return new Promise((resolve, reject) => {
      const done = (err) => (err ? reject(err) : resolve());
      if (process.platform === 'win32') {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', PS_ENCODED], {
          env: { ...process.env, OSH_IN: src, OSH_OUT: out, OSH_MAX: String(max) },
          timeout: 30000, windowsHide: true,
        }, done);
      } else {
        const bin = process.env.OSHELF_MAGICK || 'convert';
        execFile(bin, ['-auto-orient', '-thumbnail', `${max}x${max}>`, '-background', 'white', '-flatten', `${src}[0]`, `jpg:${out}`], { timeout: 30000 }, done);
      }
    });
  }

  async function get(abs, variantKey) {
    const variant = THUMB_VARIANTS[variantKey];
    if (!variant || !THUMB_EXTS.has(path.extname(abs).toLowerCase())) return null;
    const st = await fs.stat(abs).catch(() => null);
    if (!st || !st.isFile()) return null;
    const key = crypto.createHash('sha1').update(`${abs}|${st.mtimeMs}|${st.size}|${variantKey}`).digest('hex');
    const out = path.join(dir, `${key}.jpg`);
    const hit = await fs.stat(out).catch(() => null);
    if (hit && hit.size > 0) return out;
    if (inflight.has(key)) return inflight.get(key);
    const p = run(async () => {
      mkdirDone ||= fs.mkdir(dir, { recursive: true });
      await mkdirDone;
      const tmp = `${out}.${process.pid}.tmp.jpg`;
      try {
        await convert(abs, tmp, variant.max);
        await fs.rename(tmp, out);
        return out;
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        log.warn(`[thumbs] ${path.basename(abs)}: ${err.message.split('\n')[0]}`);
        return null;
      }
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function warm(abs) {
    get(abs, 'tn').catch(() => {});
    get(abs, 'sm').catch(() => {});
  }

  return { get, warm };
}
