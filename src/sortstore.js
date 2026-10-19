// src/sortstore.js — per-folder sort persistence.
//
// Storage: a single JSON document (sortstore.json) with atomic writes
// (write temp + rename) so a crash never corrupts it. Shape:
//
//   {
//     "version": 1,
//     "defaultSort": { "key": "name", "dir": "asc" },
//     "folders": {
//       "c:/media/movies": {
//         "key": "size", "dir": "desc",
//         "manualOrder": ["a.mkv", "b.mkv"],
//         "added": { "a.mkv": 1234567890000 }   // first-seen ms per entry
//       }
//     }
//   }
//
// Keys are folder paths. Every key goes through `canonical()`: realpath
// (collapses symlinks and case) then forward slashes, lowercased on
// Windows. Because the key is the identity of the folder, a rename or
// move orphans the pref; `adopt()` runs a bounded, low-cost pass that
// re-keys prefs whose old path is gone when the basename matches the
// requested folder. Wrong adoption is low-harm (user re-sorts once).

import fs from 'node:fs/promises';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

export class SortStore {
  constructor({ file = 'sortstore.json' } = {}) {
    this.file = file;
    this.data = null;
    this.writeTimer = null;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1 || typeof parsed.folders !== 'object') {
        throw new Error('unsupported store schema');
      }
      this.data = {
        defaultSort: { key: 'name', dir: 'asc', ...(parsed.defaultSort || {}) },
        folders: parsed.folders,
        roots: Array.isArray(parsed.roots) ? parsed.roots : [],
      };
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.data = { defaultSort: { key: 'name', dir: 'asc' }, folders: {}, roots: [] };
      } else {
        // Corrupt store: back it up and start fresh instead of crashing.
        try { await fs.copyFile(this.file, this.file + '.bak'); } catch {}
        this.data = { defaultSort: { key: 'name', dir: 'asc' }, folders: {}, roots: [] };
      }
    }
  }

  /** Canonical store key for a folder path (follows symlinks). */
  async canonical(absPath) {
    let resolved;
    try {
      resolved = await fs.realpath(absPath);
    } catch {
      resolved = path.resolve(absPath); // folder vanished mid-request
    }
    const k = resolved.replace(/\\/g, '/');
    return IS_WIN ? k.toLowerCase() : k;
  }

  /**
   * Effective pref for a folder: its own choice, or null when it falls back
   * to the global default. Runs orphan adoption when the folder is unknown.
   */
  async lookup(absPath) {
    const key = await this.canonical(absPath);
    const pref = this.data.folders[key] || (await this.adopt(key));
    return pref && pref.key ? pref : null;
  }

  /** Raw folder entry (manualOrder / added access). */
  async get(absPath) {
    const key = await this.canonical(absPath);
    return this.data.folders[key] || null;
  }

  /**
   * Effective sort for a folder, walking up the tree:
   *   own pref -> parent's pref -> ... -> global default.
   * Returns { pref, origin, inherited }. `origin` is the path whose pref
   * applies ('' = global default) so the GUI can show where it came from.
   * `curNames` (the browse listing) lets orphan adoption finger the folder
   * without an extra readdir.
   */
  async effective(absPath, curNames) {
    const key = await this.canonical(absPath);
    const chain = ancestors(key); // deepest -> shallowest
    for (const dir of [key, ...chain]) {
      let pref = this.data.folders[dir];
      if (dir === key && !pref) pref = await this.adopt(key, curNames);
      if (pref && pref.key) return { pref, origin: dir, folder: dir === key };
    }
    return { pref: this.data.defaultSort, origin: '', folder: false };
  }

  /** Merge a pref. { key: null } clears the folder's choice (use default). */
  async set(absPath, patch) {
    patch = patch || {};
    const key = await this.canonical(absPath);
    const cur = this.data.folders[key] || {};
    const next = { ...cur, ...patch };
    if (patch.key === null || (!next.key && !next.manualOrder)) delete this.data.folders[key];
    else this.data.folders[key] = next;
    await this.flush(true);
  }

  /** Forget every pref for a folder. */
  async clear(absPath) {
    const key = await this.canonical(absPath);
    delete this.data.folders[key];
    await this.flush(true);
  }

  setDefault(sort) {
    this.data.defaultSort = sort;
    return this.flush(true);
  }

  // Library roots managed at runtime via the GUI (persisted here so they
  // survive restarts). Roots declared on the CLI/in the config file are
  // NOT stored — they come from `server.js` each start.
  getRoots() {
    return this.data.roots;
  }

  async addRoot(root) {
    this.data.roots.push(root);
    await this.flush(true);
  }

  async removeRoot(id) {
    const i = this.data.roots.findIndex((r) => r.id === id);
    if (i === -1) return false;
    this.data.roots.splice(i, 1);
    await this.flush(true);
    return true;
  }

  /**
   * Record first-seen timestamps for new entries + a children hash used for
   * rename adoption. The write is debounced. `names` comes from the browse
   * listing, so this costs nothing extra.
   */
  async recordAdded(absPath, names) {
    const key = await this.canonical(absPath);
    const pref = this.data.folders[key] || {};
    const added = { ...(pref.added || {}) };
    const now = Date.now();
    let changed = false;
    for (const n of names) {
      if (!(n in added)) { added[n] = now; changed = true; }
    }
    if (!this.data.folders[key]) changed = true; // first visit: must create the entry
    if (changed) this.scheduleFlush();
    this.data.folders[key] = { ...pref, added, childrenHash: nameHash(names) };
  }

  /**
   * Bounded orphan adoption: the requested folder had no pref, so look for
   * stored prefs whose old path no longer exists and whose children hash
   * matches the live listing — this survives both moves *and* renames.
   * Capped so a large store cannot stall a browse.
   */
  async adopt(key, curNames) {
    let hash;
    try {
      if (!curNames || curNames.length === 0) {
        const keyPath = key.replace(/\//g, path.sep);
        curNames = await fs.readdir(keyPath);
      }
      hash = nameHash(curNames);
    } catch {
      return null; // folder unreadable — nothing to adopt from
    }
    let scanned = 0;
    for (const [oldKey, pref] of Object.entries(this.data.folders)) {
      if (++scanned > 500) break;
      if (oldKey === key) continue;
      if (!pref.childrenHash || pref.childrenHash !== hash) continue;
      if (await exists(oldKey)) continue; // old path still there, not an orphan
      this.data.folders[key] = { ...pref, childrenHash: hash };
      delete this.data.folders[oldKey];
      this.scheduleFlush();
      return pref;
    }
    return null;
  }

  scheduleFlush() {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush(true);
    }, 500);
  }

  /** Atomic write: temp file + rename. Force bypasses the debounce. */
  async flush(force = false) {
    if (!force && !this.writeTimer) return;
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify({ version: 1, ...this.data }, null, 1), 'utf8');
    await fs.rename(tmp, this.file);
  }
}

/** File exists on disk, given a store key (forward slashes, maybe lowercased). */
async function exists(key) {
  const p = key.replace(/\//g, path.sep);
  try { await fs.access(p); return true; } catch { return false; }
}

/** Folder keys from deepest to shallowest, ending with the drive/volume root. */
function ancestors(key) {
  const out = [];
  const parts = key.split('/');
  for (let i = parts.length - 1; i >= 1; i--) {
    out.push(parts.slice(0, i).join('/'));
  }
  return out;
}

/** Cheap content-insensitive fingerprint of a folder's entry names. */
function nameHash(names) {
  const joined = [...names].sort().join('\u0000');
  let h = 5381;
  for (let i = 0; i < joined.length; i++) {
    h = ((h * 33) ^ joined.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}
