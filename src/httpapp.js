// src/httpapp.js — HTTP layer: browse API, range-enabled streaming, static UI.
//
// Streaming strategy: the stream endpoint opens a read stream over exactly
// the requested byte range and replies 206 with Content-Range — every
// browser/player seeks by issuing new Range requests, so this is what makes
// scrubbing work. No transcoding happens anywhere: the file is served
// byte-for-byte as stored.
//
// Security model (v1): paths are resolved against a configured root and
// checked to stay inside it (case-insensitive on Windows). Symlinks are
// followed, so a link pointing outside a root escapes the check — accepted
// for a trusted, LAN-only server; documented in README.

import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import {
  Library, classify, mediaType, compareEntries, applyManualOrder, SORT_KEYS,
} from './library.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const APP_DIR = path.dirname(fileURLToPath(import.meta.url)); // this module's dir

// Static-file MIME map. Module scripts in particular *require* a JS MIME
// type or the browser refuses to execute them.
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

export function createApp({ roots, declaredRootIds = [], lib, store, extra }) {
  const server = createServer(asyncHandler(route));

  async function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;
    const q = url.searchParams;

    try {
      if (pathname === '/api/roots' && req.method === 'GET') {
        return json(res, 200, { roots: rootsPublic() });
      }

      if (pathname === '/api/browse') {
        const root = findRoot(q.get('root'));
        if (!root) return json(res, 400, { error: { code: 'UNKNOWN_ROOT', message: 'Unknown root' } });
        const dir = resolveWithin(root.path, q.get('path') || '');
        const entries = await lib.list(dir);
        const names = entries.map((e) => e.name);
        // Adopt-first ordering matters: recordAdded() would create an entry at
        // this key and suppress the orphan-adoption path in effective().
        const eff = await store.effective(dir, names);
        void store.recordAdded(dir, names).catch(() => {}); // first-seen timestamps (debounced; never crash on store errors)
        const pref = eff.pref;
        let sorted;
        if (pref.key === 'manual' && eff.folder) {
          sorted = applyManualOrder(entries, eff.pref.manualOrder || []);
        } else if (pref.key === 'manual') {
          // inherited manual order describes the parent's children, not ours
          sorted = [...entries].sort((a, b) => compareEntries(a, b, 'name', pref.dir));
        } else {
          if (pref.key === 'duration') await lib.enrichDurations(dir, entries);
          const addedMs = new Map(Object.entries(pref.added || {}));
          sorted = [...entries].sort((a, b) => compareEntries(a, b, pref.key, pref.dir, addedMs));
        }
        const rel = path.relative(root.path, dir) || '';
        return json(res, 200, {
          root: root.id, path: rel, name: path.basename(dir) || root.name,
          parent: rel ? (path.dirname(rel) === '.' ? '' : path.dirname(rel)) : null,
          sort: { key: pref.key, dir: pref.dir },
          sortOrigin: originInfo(root, eff),
          count: entries.length,
          entries: sorted.map(pubEntry),
        });
      }

      if (pathname === '/api/sort') return await sortRoutes(req, res, q);
      if (pathname === '/api/roots') return await rootsRoutes(req, res, q);
      if (pathname === '/api/default') return await defaultRoutes(req, res);

      if (pathname === '/api/stream') {
        const root = findRoot(q.get('root'));
        const abs = root ? resolveWithin(root.path, q.get('path') || '') : null;
        if (!abs) return json(res, 400, { error: { code: 'UNKNOWN_ROOT', message: 'Unknown root' } });
        return await serveRange(req, res, abs);
      }

      // Static UI
      if (pathname === '/') {
        return await serveFile(res, path.join(APP_DIR, '../public/index.html'), 'text/html; charset=utf-8');
      }
      if (pathname.startsWith('/public/')) {
        const file = path.join(APP_DIR, '..', 'public', pathname.slice('/public/'.length));
        const type = STATIC_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
        return await serveFile(res, file, type);
      }

      // Optional extra surface (currently UPnP/DLNA). It returns true when
      // it handled the request; false falls through to the 404 below.
      if (extra) {
        if (await extra(req, res, url)) return;
      }

      json(res, 404, { error: { code: 'NOT_FOUND', message: 'No such route' } });
    } catch (err) {
      const code = err.code || 'INTERNAL';
      const status = {
        ENOENT: 404, ENOTDIR: 404, EACCES: 403, EPERM: 403,
        BAD_JSON: 400, PAYLOAD_TOO_LARGE: 400,
      }[code] || 500;
      if (status === 500) console.error('[http]', err);
      if (!res.headersSent) json(res, status, { error: { code, message: err.message } });
      else res.destroy();
    }
  }

  function rootsPublic() {
    return roots.map((r) => ({ id: r.id, name: r.name, path: r.path }));
  }

  function findRoot(id) {
    if (!id) return undefined;
    id = id.replace(/\\/g, '/').toLowerCase();
    return roots.find((r) => r.id === id || r.name.toLowerCase() === id);
  }

  function resolveWithin(rootPath, rel) {
    // rel must stay inside the root; slashes normalise on every platform.
    const cleaned = path.join(rootPath, rel.replace(/\\/g, '/'));
    const rootLower = rootPath.toLowerCase();
    const cleanedLower = cleaned.toLowerCase();
    if (cleanedLower !== rootLower && !cleanedLower.startsWith(rootLower + path.sep.toLowerCase())) {
      const e = new Error('Path escapes root');
      e.code = 'EACCES';
      throw e;
    }
    return cleaned;
  }

  function pubEntry(e) {
    return {
      name: e.name, isDir: e.isDir, kind: e.kind, size: e.size,
      mtimeMs: e.mtimeMs, link: e.link, readable: e.readable,
      duration: e.duration, error: e.error || undefined,
    };
  }

  // ---- Global default sort -------------------------------------------------

  async function defaultRoutes(req, res) {
    if (req.method === 'GET') {
      return json(res, 200, { default: store.data.defaultSort });
    }
    if (req.method === 'PUT') {
      const body = await readJson(req);
      if (!body.key || ![...SORT_KEYS].includes(body.key) || !['asc', 'desc'].includes(body.dir)) {
        return json(res, 400, { error: { code: 'BAD_DEFAULT', message: 'Valid { key, dir } required' } });
      }
      await store.setDefault({ key: body.key, dir: body.dir });
      return json(res, 200, { ok: true, default: store.data.defaultSort });
    }
    return json(res, 405, { error: { code: 'METHOD', message: 'Use GET or PUT' } });
  }

  // ---- Sort preference API -------------------------------------------------

  async function sortRoutes(req, res, q) {
    const root = findRoot(q.get('root'));
    if (!root) return json(res, 400, { error: { code: 'UNKNOWN_ROOT', message: 'Unknown root' } });
    const abs = resolveWithin(root.path, q.get('path') || '');
    if (req.method === 'GET') {
      return json(res, 200, {
        default: store.data.defaultSort,
        own: await store.get(abs),
        effective: await store.effective(abs),
      });
    }
    if (req.method === 'PUT') {
      const body = await readJson(req);
      const patch = {};
      if (Object.hasOwn(body, 'key')) patch.key = body.key;
      if (Object.hasOwn(body, 'dir')) patch.dir = body.dir;
      if (Array.isArray(body.manualOrder)) patch.manualOrder = body.manualOrder;
      if ('key' in patch && patch.key !== null && ![...SORT_KEYS, 'manual'].includes(patch.key)) {
        return json(res, 400, { error: { code: 'BAD_SORT_KEY', message: `Unknown sort key: ${patch.key}` } });
      }
      if ('dir' in patch && patch.dir !== null && !['asc', 'desc'].includes(patch.dir)) {
        return json(res, 400, { error: { code: 'BAD_DIR', message: 'dir must be asc or desc' } });
      }
      await store.set(abs, patch);
      return json(res, 200, { ok: true, own: await store.get(abs) });
    }
    if (req.method === 'DELETE') {
      await store.clear(abs);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { code: 'METHOD', message: 'Use GET, PUT or DELETE' } });
  }

  // ---- Runtime root management ---------------------------------------------

  async function rootsRoutes(req, res, q) {
    if (req.method === 'POST') {
      const body = await readJson(req);
      if (!body.path) return json(res, 400, { error: { code: 'BAD_ROOT', message: 'path required' } });
      let st;
      try {
        st = await fss.promises.stat(body.path);
      } catch (e) {
        return json(res, 400, { error: { code: 'BAD_ROOT', message: `Cannot access path: ${e.message}` } });
      }
      if (!st.isDirectory()) return json(res, 400, { error: { code: 'BAD_ROOT', message: 'Not a directory' } });
      const abs = path.resolve(body.path);
      const root = {
        id: abs.replace(/\\/g, '/').toLowerCase(),
        path: abs,
        name: body.name || path.basename(abs) || abs,
      };
      if (!findRoot(root.id)) {
        roots.push(root);
        await store.addRoot(root);
      }
      return json(res, 201, { root: roots.find((r) => r.id === root.id) });
    }
    if (req.method === 'DELETE') {
      const id = (q.get('id') || '').replace(/\\/g, '/').toLowerCase();
      if (!id) return json(res, 400, { error: { code: 'BAD_ROOT', message: 'id required' } });
      if (declaredRootIds.includes(id)) {
        return json(res, 400, { error: { code: 'CONFIG_ROOT', message: 'Root is declared in config; remove it there' } });
      }
      await store.removeRoot(id);
      const i = roots.findIndex((r) => r.id === id);
      if (i === -1) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'No such root' } });
      roots.splice(i, 1);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { code: 'METHOD', message: 'Use POST or DELETE' } });
  }

  /** Where the applied sort came from: this folder, an ancestor, or global. */
  function originInfo(root, eff) {
    if (eff.origin === '') return { level: 'global', path: '' };
    const abs = eff.origin.replace(/\//g, path.sep);
    let rel = path.relative(root.path, abs).replace(/\\/g, '/');
    if (rel.startsWith('..')) rel = abs; // outside this root — show absolute
    return { level: eff.folder ? 'folder' : 'parent', path: rel };
  }

  return server;
}

// ---- Range streaming -------------------------------------------------------

async function serveRange(req, res, abs) {
  // Callback-form stat: fs.promises.stat can double-deliver on pathological
  // names (see library.js note) and crash the process. Callbacks fire once.
  const st = await new Promise((resolve) => {
    fss.stat(abs, (err, stats) => (err ? resolve(null) : resolve(stats)));
  });
  if (!st) {
    return json(res, 404, { error: { code: 'ENOENT', message: 'File not found or unreadable' } });
  }
  if (!st.isFile()) return json(res, 400, { error: { code: 'NOT_A_FILE', message: 'Path is not a file' } });

  if (!st.isFile()) return json(res, 400, { error: { code: 'NOT_A_FILE', message: 'Path is not a file' } });

  const size = st.size;
  const mtime = new Date(st.mtimeMs).toUTCString();
  const type = mediaType(abs);

  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': type,
    'Last-Modified': mtime,
    'Cache-Control': 'no-transform', // never transcode, never cache-chunk
  };

  const rangeHdr = req.headers.range;
  if (rangeHdr) {
    // If-Range: if it no longer matches the current mtime, serve the full file.
    if (req.headers['if-range'] && req.headers['if-range'] !== mtime) {
      return send(200, headers, 0, size - 1);
    }
    const range = parseRange(rangeHdr, size);
    if (range === null) return send(200, headers, 0, size - 1); // malformed/multi -> ignore
    if (range === 'invalid') {
      return json(res, 416, {
        error: { code: 'RANGE_NOT_SATISFIABLE', message: 'Requested range not satisfiable' },
        headers: { 'Content-Range': `bytes */${size}`, ...headers },
      });
    }
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    return send(206, headers, range.start, range.end);
  }
  return send(200, headers, 0, size - 1);

  /**
   * writeHead + pipe the requested range; never returns undefined.
   * serveRange is awaited from route(), which uses the truthiness to know
   * the response is done — an undefined return would make route() fall
   * through to the 404 and double-write (ERR_HTTP_HEADERS_SENT).
   */
  async function send(status, h, start, end) {
    const len = end - start + 1;
    res.writeHead(status, { ...h, 'Content-Length': len });
    if (req.method === 'HEAD') { res.end(); return true; }
    return new Promise((resolve) => {
      const stream = fss.createReadStream(abs, { start, end, autoClose: true });
      stream.on('error', (e) => { res.destroy(e); resolve(true); });
      stream.on('close', () => resolve(true));
      stream.pipe(res);
    });
  }
}

/** Single-range parser per RFC 7233. Returns {start,end} | 'invalid' | null(serve full). */
function parseRange(hdr, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(hdr.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start, end;
  if (a === '') { // suffix: last b bytes
    const n = parseInt(b, 10);
    if (n <= 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(a, 10);
    end = b === '' ? size - 1 : parseInt(b, 10);
    if (start >= size) return 'invalid';
    if (end >= size) end = size - 1;
    if (start > end) return 'invalid';
  }
  return size === 0 ? 'invalid' : { start, end };
}

// ---- Small helpers ---------------------------------------------------------

async function serveFile(res, abs, type) {
  const body = await fs.readFile(abs); // ENOENT -> 404
  res.writeHead(200, { 'Content-Type': type || 'application/octet-stream' });
  res.end(body);
}

function json(res, status, obj) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(obj));
}

/** Read a small JSON request body; empty body resolves to {}. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error('Body too large'), { code: 'PAYLOAD_TOO_LARGE' }));
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { code: 'BAD_JSON' }));
      }
    });
    req.on('error', reject);
  });
}

/** Wrap the router so thrown errors reach the catch block in `route`. */
function asyncHandler(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    if (!res.headersSent) {
      json(res, 500, { error: { code: 'INTERNAL', message: err.message } });
    } else res.destroy();
  });
}
