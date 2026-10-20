# OpenShelf

A lightweight, self-hosted media server that **serves your media files exactly as they are** — no transcoding, ever. Direct HTTP streaming with full Range support, per-folder sort memory, and a simple web UI. A simpler alternative to Universal Media Server for the case UMS handles poorly: sorting any folder however you want, remembered per folder.

## What it is — and is not

- Serves video, audio, image, and any other file byte-for-byte over HTTP (`206 Partial Content`, seeking works everywhere).
- Browsable folder tree over one or more library roots.
- **Per-folder sort memory**: each folder can have its own sort (Name, Date modified, Date added, Size, Type, Duration, Manual order) with asc/desc; folders with no saved sort use the global default. Sorts survive restarts and are keyed by folder path.
- No transcoding, no user accounts, no cloud, no metadata scraping (v1 — room to grow).

## Requirements

- Node.js **>= 18** (tested on 20.x), Windows or Linux.
- Zero runtime dependencies.

## Quick start

**Windows:** double-click `start.bat` — it opens the web UI in your browser and serves your library (edit `openshelf.config.json` — copy the example first — to choose which folders are roots). `stop.bat` force-closes the server and frees its memory.

**Anywhere (Node >= 18, zero dependencies):**

```sh
node server.js --root "C:/Media/Movies" --root "C:/Media/Music" --port 8090
```

Open http://localhost:8090 — add/remove library folders and change per-folder sorts from the UI. Runtime-added roots persist in `sortstore.json`.

## Configuration

Command-line flags (env vars `OSHELF_*` also work):

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--root <path>` | — | cwd | Add a library root (repeatable) |
| `--port <n>` | OSHELF_PORT | 8090 | HTTP port |
| `--host <addr>` | OSHELF_HOST | 0.0.0.0 | Bind address |
| `--config <file>` | OSHELF_CONFIG | — | JSON config file (see below) |
| `--cache-ttl <ms>` | OSHELF_CACHE_TTL | 30000 | Directory listing cache lifetime |
| — | OSHELF_PEERS | — | Space-separated IPs to unicast SSDP NOTIFY to (e.g. a phone that misses multicast) |
| — | OSHELF_DEBUG_SSDP | — | Set to 1 to log every SSDP packet (diagnostics) |
| `--store <file>` | OSHELF_STORE | sortstore.json | Sort-preference store path |
| `--data-dir <dir>` | OSHELF_DATA | store's dir | Runtime files directory |
| `--upnp off` | OSHELF_UPNP | on | Disable the UPnP stub |

JSON config file (keys mirror flags minus the ones given on the command line):

```json
{
  "host": "0.0.0.0",
  "port": 8090,
  "roots": ["C:/Media/Movies", "C:/Media/Music"],
  "cacheTtlMs": 30000,
  "storeFile": "sortstore.json",
  "dataDir": "./data"
}
```

## How sort memory works

- The **effective sort** of a folder is its own saved sort, else the nearest ancestor's, else the **global default** (setable from the sidebar). The UI shows where the applied sort came from.
- **Manual order** is a persisted, per-folder sequence of entry names, arranged with up/down arrows in the UI.
- **Date added** is the first time OpenShelf saw the file (there's no historical metadata to recover a true added date).
- **Rename/move survival**: each listed folder records a hash of its child names; when a folder's stored key no longer exists, the pref is adopted by any live folder with the same children hash — so a renamed or moved folder keeps its sort. The adoption pass is bounded (500 entries).
- Storage is a single JSON file (`sortstore.json`) with atomic writes (temp + rename); a corrupt store is backed up as `.bak` and recreated.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/browse?root=&path=` | Folder listing with the effective sort applied |
| GET / PUT / DELETE | `/api/sort?root=&path=` | Read / save (`{key, dir}` or `{key:"manual", manualOrder:[...]}`) / clear a folder's sort |
| GET / PUT | `/api/default` | Global default sort |
| GET / POST / DELETE | `/api/roots` | List / add (`{path}`) / remove (`?id=`) library roots |
| GET | `/api/stream?root=&path=` | Ranged file streaming (also where `HEAD` lives) |

Browse response shape (abridged):

```json
{
  "root": "c:/media/movies",
  "path": "Sub/Dir",
  "sort": { "key": "size", "dir": "desc" },
  "sortOrigin": { "level": "parent", "path": "Sub" },
  "entries": [
    { "name": "a.mkv", "isDir": false, "kind": "video", "size": 1234,
      "mtimeMs": 1700000000000, "duration": 6023, "link": false, "readable": true }
  ]
}
```

`sortOrigin.level` is `folder` (set here), `parent` (inherited), or `global`. `duration` appears only for probed mp4/mkv.

## Streaming details

- Full RFC 7233 Range: `200` (full), `206` with `Content-Range`, `416` for unsatisfiable, `HEAD` support, `If-Range`/`Last-Modified`.
- `Accept-Ranges: bytes` and `Cache-Control: no-transform` on every stream.
- The stream endpoint reads the file at request time — files that change or grow while the server runs are served correctly without a full rescan.

## Efficiency on large libraries

- Nothing is scanned up front. A folder is read on first request (`readdir` + per-entry stat, one batch), cached for `--cache-ttl` ms, and validated against the folder's own mtime, so a huge library costs one listing per visited folder.
- 2000-entry folder: ~0.2s first browse, ~0.01s cached.
- Durations are probed only when a folder's sort key is `duration`, and cached on the entry.

## Edge cases handled

- Special characters in names (spaces, brackets, `#`, `&`, emoji, `%`, parens) — always URL-encoded client-side.
- Unreadable entries (permissions, dangling symlinks, vanishing files, pathological NTFS names) are listed as placeholders with an error, never crash the server, and stream as 404.
- Symlinked folders/files are followed and flagged with a `link` badge.
- Files that change/delete while running: cache TTL + request-time stats cover it.
- A folder whose root path disappears mid-run returns 404 for that request instead of crashing.

## Project layout

```
server.js            Entry point: config, store, wiring, listeners
src/config.js        CLI/env/config-file parsing
src/httpapp.js       HTTP routes, Range streaming, static UI
src/library.js       Lazy directory cache, classification, sorting
src/sortstore.js     Per-folder sort persistence (JSON, atomic, adoption)
src/probe.js         Zero-dependency mp4/mkv duration probing
src/upnp.js          UPnP/DLNA: SSDP discovery + ContentDirectory SOAP
start.bat / stop.bat Windows launcher: start with browser, force-stop
public/              index.html, app.js, style.css (no build step)
```

## DLNA / UPnP

Implemented: OpenShelf announces itself as a UPnP MediaServer and answers ContentDirectory Browse over SOAP, reusing the exact same library + per-folder sort logic as the web UI — so your saved sorts apply to DLNA clients too. Use BubbleUPnP (or any UPnP browser) to find "OpenShelf", then browse your library folders; files stream with Range support through the same `/api/stream` endpoint (no transcoding).

- **Discovery**: SSDP on `239.255.255.250:1900` — responds to M-SEARCH and sends NOTIFY alive every 60 s. On Windows the OS "SSDP Discovery" service (SSDPSRV) binds port 1900 first and Windows delivers multicast to only one socket; if a device doesn't see OpenShelf, stop that service from an admin prompt: `net stop SSDPSRV` (this is the known Windows fix; OpenShelf logs this hint at startup).
- Device description: `/upnp/device.xml`; services: ContentDirectory (`/upnp/control`) and ConnectionManager.
- Sort memory travels: Browse applies the stored/inherited sort for each folder via `store.effective()`.
- Toggle with `--upnp off` / `"upnp": false` in the config file.

## Development

```sh
node --check server.js src/*.js        # syntax check
node server.js --root <media> --port 8090   # run
```

## Roadmap (not v1)

- Probes for more containers (avi, webm durations need deeper parsing or an external tool)
- Metadata scraping hook (the `entry` shape already carries `kind`/`duration`; a scraper would add `title`, `year`, artwork)
- Optional: serve SMB-style OS mounting via WebDAV (reuses the browse/stream layer)
