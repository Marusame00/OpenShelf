// src/library.js — filesystem scanning plus the per-directory cache.
//
// Design notes:
//  - Lazy: nothing is scanned up front. A folder is read on first request
//    and cached for `ttlMs`, keyed on the folder's own mtime (which changes
//    when entries are added/removed/renamed).
//  - File *content* changes do not touch the folder mtime, so they surface
//    within one TTL — acceptable for a browse view, and the stream endpoint
//    never uses this cache (it reads the file at request time).
//  - One readdir() batch call plus per-entry stat() per visit — a huge
//    folder costs one listing, not a rescan of the tree.
//  - The platform collator gives natural, locale-aware sort (a2.mp4 < a10.mp4).

import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { probeDuration } from './probe.js';

export const KINDS = {
  video: ['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.mpg', '.mpeg', '.ts', '.m2ts', '.flv'],
  audio: ['.mp3', '.flac', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.opus', '.wma', '.aiff'],
  image: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.tif', '.avif', '.heic', '.jxl'],
};

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.flv': 'video/x-flv',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.tiff': 'image/tiff',
  '.tif': 'image/tiff', '.avif': 'image/avif', '.heic': 'image/heic', '.jxl': 'image/jxl',
};

export function classify(name, isDir) {
  if (isDir) return 'folder';
  const ext = path.extname(name).toLowerCase();
  if (KINDS.video.includes(ext)) return 'video';
  if (KINDS.audio.includes(ext)) return 'audio';
  if (KINDS.image.includes(ext)) return 'image';
  return 'other';
}

export function mediaType(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

export class Library {
  constructor({ ttlMs = 30000 } = {}) {
    this.ttlMs = ttlMs;
    this.cache = new Map(); // absPath -> { mtimeMs, at, entries }
  }

  /** List a directory (follows symlinks). Throws {code:'ENOENT'|'ENOTDIR'|'EACCES'} on failure. */
  async list(absDir) {
    const st = await fs.stat(absDir); // follows symlinks
    const hit = this.cache.get(absDir);
    if (hit && hit.mtimeMs === st.mtimeMs && Date.now() - hit.at <= this.ttlMs) {
      return hit.entries;
    }
    const names = await fs.readdir(absDir);
    const entries = [];
    for (const name of names) {
      const full = path.join(absDir, name);
      let entry;
      try {
        // Sync stats for broken-entry safety: on some Windows paths (names
        // readdir returns but the filesystem cannot resolve) Node 20.10's
        // fs.promises.stat delivers a *second* rejection with no handler,
        // which crashes the process even inside try/catch. statSync has no
        // promise machinery, so nothing can double-fire.
        const st = fss.statSync(full);
        let lst = null;
        try { lst = fss.lstatSync(full); } catch { lst = st; }
        const isDir = st.isDirectory();
        entry = {
          name, path: full,
          isDir, size: st.size, mtimeMs: st.mtimeMs,
          kind: classify(name, isDir),
          link: lst.isSymbolicLink(),
          readable: true,
          duration: null, // filled lazily by the probe
        };
      } catch (err) {
        // Unreadable entry (permission, dangling symlink, vanished file,
        // broken NTFS name): keep a placeholder so the folder still lists.
        const msg = err && err.code ? err.code : String(err);
        entry = {
          name, path: full, isDir: false, size: null, mtimeMs: null,
          kind: 'other', link: null, readable: false, duration: null,
          error: msg,
        };
      }
      entries.push(entry);
    }
    this.cache.set(absDir, { mtimeMs: st.mtimeMs, at: Date.now(), entries });
    return entries;
  }

  /** Force a re-list on the next request (used when a folder mutates externally). */
  invalidate(absDir) {
    this.cache.delete(absDir);
  }

  /**
   * Lazily probe durations for media entries in a freshly listed folder.
   * Only called when the folder's effective sort is `duration` — avoids
   * probing entire libraries for nothing. Results are stored back on the
   * cached entries, so a repeat visit costs nothing. Failures leave
   * duration null (sorts last in ascending order).
   */
  async enrichDurations(absDir, entries) {
    const targets = entries.filter((e) => !e.isDir && (e.kind === 'video' || e.kind === 'audio') && e.readable && e.duration === null);
    if (targets.length === 0) return;
    await Promise.all(targets.map(async (e) => {
      try {
        e.duration = await probeDuration(e.path);
      } catch {
        e.duration = null;
      }
    }));
    const hit = this.cache.get(absDir);
    if (hit) hit.at = Date.now(); // keep the enriched entries fresh
  }
}

// ---- Sorting -----------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const SORT_KEYS = ['name', 'mtime', 'added', 'size', 'type', 'duration'];

function kindRank(kind) {
  return { folder: 0, video: 1, audio: 2, image: 3, other: 4 }[kind] ?? 5;
}

/**
 * Stable comparison of two entries for a sort key and direction.
 * Directories always sort before files (standard for library browsers);
 * within that, the chosen key applies. Unavailable values (null size,
 * unknown duration) sort as -1, so they land at the end for asc / top
 * for desc. Ties break on the natural name order — the list stays stable.
 *
 * `addedMs` comes from the sort store (first-seen timestamps), and
 * `manualOrder` is a preserved name ordering produced by the caller.
 */
export function compareEntries(a, b, key = 'name', dir = 'asc', addedMs) {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // folders float first
  let r;
  switch (key) {
    case 'type':
      r = kindRank(a.kind) - kindRank(b.kind) || collator.compare(a.name, b.name);
      break;
    case 'size':
      r = (a.size ?? -1) - (b.size ?? -1) || collator.compare(a.name, b.name);
      break;
    case 'mtime':
      r = (a.mtimeMs ?? -1) - (b.mtimeMs ?? -1) || collator.compare(a.name, b.name);
      break;
    case 'added':
      r = (addedMs.get(a.name) ?? -1) - (addedMs.get(b.name) ?? -1) ||
          collator.compare(a.name, b.name);
      break;
    case 'duration':
      r = (a.duration ?? -1) - (b.duration ?? -1) || collator.compare(a.name, b.name);
      break;
    case 'name':
    default:
      r = collator.compare(a.name, b.name);
  }
  return dir === 'desc' ? -r : r;
}

/**
 * Apply a stored manual order (array of names) to entries. Named entries
 * keep their stored sequence; the rest are appended in natural order.
 * Returns a new array — never mutates the cache.
 */
export function applyManualOrder(entries, order) {
  if (!Array.isArray(order) || order.length === 0) return entries;
  const byName = new Map(entries.map((e) => [e.name, e]));
  const named = [];
  const rest = [];
  for (const name of order) {
    const e = byName.get(name);
    if (e) { named.push(e); byName.delete(name); }
  }
  rest.push(...byName.values());
  rest.sort((a, b) => collator.compare(a.name, b.name));
  return [...named, ...rest];
}
