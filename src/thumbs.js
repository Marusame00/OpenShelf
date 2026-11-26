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
  "$ErrorActionPreference = 'Stop'",
  'try {',
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
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
].join('\n');

const PS_ENCODED = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');

export function createThumbs({ dir, concurrency = 2, enabled = true, maxMb = 300, log = console }) {
  const state = { enabled, maxBytes: maxMb * 1024 * 1024 };
  let pruning = null;
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
      const done = (err, stdout, stderr) => {
        if (!err) return resolve();
        // PowerShell puts the real reason on stderr; err.message is just the
        // (enormous) command line, so never log that.
        const lines = String(stderr || '').split('\n').map((l) => l.trim())
          .filter((l) => l && !l.startsWith('<'));
        const detail = lines.length ? lines[lines.length - 1] : (err.code || 'conversion failed');
        reject(new Error(detail.slice(0, 200)));
      };
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

  // Windows refuses to rename over a file another process holds open (EPERM),
  // which happens when a DLNA client is still reading the thumbnail. Retry a
  // few times, and treat an existing non-empty target as success.
  async function renameInto(tmp, out) {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, out);
        return true;
      } catch (err) {
        const retryable = err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EEXIST';
        if (!retryable) throw err;
        const cur = await fs.stat(out).catch(() => null);
        if (cur && cur.isFile() && cur.size > 0) {
          await fs.rm(tmp, { force: true }).catch(() => {});
          return true;
        }
        if (attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  }

  async function usage() {
    const names = await fs.readdir(dir).catch(() => []);
    const files = [];
    for (const n of names) {
      const st = await fs.stat(path.join(dir, n)).catch(() => null);
      if (st && st.isFile()) files.push({ p: path.join(dir, n), size: st.size, t: st.mtimeMs });
    }
    return files;
  }

  async function prune() {
    if (pruning) return pruning;
    pruning = (async () => {
      const files = await usage();
      let total = files.reduce((a, f) => a + f.size, 0);
      if (total <= state.maxBytes) return;
      const target = state.maxBytes * 0.9;
      files.sort((a, b) => a.t - b.t);
      for (const f of files) {
        if (total <= target) break;
        await fs.rm(f.p, { force: true }).catch(() => {});
        total -= f.size;
      }
    })().finally(() => { pruning = null; });
    return pruning;
  }

  async function clear() {
    const files = await usage();
    await Promise.all(files.map((f) => fs.rm(f.p, { force: true }).catch(() => {})));
  }

  async function configure({ enabled: en, maxMb: mb }) {
    if (typeof mb === 'number' && mb >= 10) state.maxBytes = mb * 1024 * 1024;
    if (typeof en === 'boolean') state.enabled = en;
    if (!state.enabled) await clear(); else await prune();
  }

  async function stats() {
    const files = await usage();
    return { enabled: state.enabled, maxMb: Math.round(state.maxBytes / 1048576), bytes: files.reduce((a, f) => a + f.size, 0), files: files.length };
  }

  async function get(abs, variantKey) {
    if (!state.enabled) return null;
    const variant = THUMB_VARIANTS[variantKey];
    if (!variant || !THUMB_EXTS.has(path.extname(abs).toLowerCase())) return null;
    const st = await fs.stat(abs).catch(() => null);
    if (!st || !st.isFile()) return null;
    const key = crypto.createHash('sha1').update(`${abs}|${st.mtimeMs}|${st.size}|${variantKey}`).digest('hex');
    const out = path.join(dir, `${key}.jpg`);
    const hit = await fs.stat(out).catch(() => null);
    if (hit && hit.isFile() && hit.size > 0) {
      if (Date.now() - hit.mtimeMs > 3600000) fs.utimes(out, new Date(), new Date()).catch(() => {});
      return out;
    }
    if (inflight.has(key)) return inflight.get(key);
    const p = run(async () => {
      mkdirDone ||= fs.mkdir(dir, { recursive: true });
      await mkdirDone;
      const tmp = `${out}.${process.pid}.tmp.jpg`;
      try {
        await convert(abs, tmp, variant.max);
        await renameInto(tmp, out);
        prune().catch(() => {});
        return out;
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        log.warn(`[thumbs] ${path.basename(abs)}: ${String(err.message).slice(0, 200)}`);
        return null;
      }
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function warm(abs) {
    if (!state.enabled) return;
    get(abs, 'tn').catch(() => {});
    get(abs, 'sm').catch(() => {});
  }

  prune().catch(() => {});
  return { get, warm, clear, configure, stats, isEnabled: () => state.enabled };
}
