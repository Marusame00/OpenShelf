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
import { createServer } from 'node:http';
import { Library, classify, mediaType, compareEntries } from './library.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

export function createApp({ roots, lib, ttlMs = 30000, getSort = () => null }) {
  const server = createServer(asyncHandler(route));

  async function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;
    const q = url.searchParams;

    try {
      if (pathname === '/api/roots') return json(res, 200, { roots: rootsPublic() });

      if (pathname === '/api/browse') {
        const root = findRoot(q.get('root'));
        if (!root) return json(res, 400, { error: { code: 'UNKNOWN_ROOT', message: 'Unknown root' } });
        const dir = resolveWithin(root.path, q.get('path') || '');
        const entries = await lib.list(dir);
        const sort = getSort(dir); // { key, dir } or null -> default
        const eff = sort || { key: 'name', dir: 'asc' };
        const sorted = [...entries].sort((a, b) =>
          compareEntries(a, b, eff.key, eff.dir, new Map()));
        const rel = path.relative(root.path, dir) || '';
        return json(res, 200, {
          root: root.id, path: rel, name: path.basename(dir) || root.name,
          parent: rel ? (path.dirname(rel) === '.' ? '' : path.dirname(rel)) : null,
          sort: eff, // what was applied
          saved: sort !== null, // whether a per-folder pref exists
          count: entries.length,
          entries: sorted.map(pubEntry),
        });
      }

      if (pathname === '/api/stream') {
        const root = findRoot(q.get('root'));
        const abs = root ? resolveWithin(root.path, q.get('path') || '') : null;
        if (!abs) return json(res, 400, { error: { code: 'UNKNOWN_ROOT', message: 'Unknown root' } });
        return await serveRange(req, res, abs);
      }

      // Static UI
      if (pathname === '/') return await serveFile(res, path.join(import.meta.dirname, '../public/index.html'), 'text/html; charset=utf-8');
      if (pathname.startsWith('/public/')) {
        const file = path.join(import.meta.dirname, '..', 'public', pathname.slice('/public/'.length));
        return await serveFile(res, file, null);
      }

      json(res, 404, { error: { code: 'NOT_FOUND', message: 'No such route' } });
    } catch (err) {
      const code = err.code || 'INTERNAL';
      const status = { ENOENT: 404, ENOTDIR: 404, EACCES: 403, EPERM: 403 }[code] || 500;
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

  return server;
}

// ---- Range streaming -------------------------------------------------------

async function serveRange(req, res, abs) {
  const st = await fs.stat(abs); // absent file => ENOENT -> 404
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

  function send(status, h, start, end) {
    const len = end - start + 1;
    res.writeHead(status, { ...h, 'Content-Length': len });
    if (req.method === 'HEAD') return res.end();
    const stream = fss.createReadStream(abs, { start, end, autoClose: true });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
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

/** Wrap the router so thrown errors reach the catch block in `route`. */
function asyncHandler(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    if (!res.headersSent) {
      json(res, 500, { error: { code: 'INTERNAL', message: err.message } });
    } else res.destroy();
  });
}
