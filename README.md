# OpenShelf

A lightweight, self-hosted media server that **serves your media files exactly as they are** — no transcoding, ever. Direct HTTP streaming with full Range support, per-folder sort memory, a web UI, and DLNA for TVs and consoles. A simpler alternative to Universal Media Server for the case UMS handles poorly: sorting any folder however you want, remembered per folder.

Barebones by default, with one optional extra: a small on-disk thumbnail cache so photo previews work on clients like the Xbox. Turn it off and OpenShelf is back to serving bytes and nothing else.

## What it is — and is not

- Serves video, audio, image, and any other file byte-for-byte over HTTP (`206 Partial Content`, seeking works everywhere).
- Browsable folder tree over one or more library roots.
- **Per-folder sort memory**: each folder can have its own sort (Name, Date modified, Date added, Size, Type, Duration, Manual order) with asc/desc; folders with no saved sort use the global default. Sorts survive restarts and are keyed by folder path.
- **Optional thumbnail cache** (on by default, one checkbox to turn off): small JPEG previews of photos for DLNA clients, stored in `<data dir>/thumbs`, capped at a rolling size limit (default 300 MB, oldest removed first). Unchecking it deletes the folder and stops generating thumbnails. Originals are never modified or re-encoded.
- Not a transcoder for video or audio (the only generated files are the optional photo thumbnails), no user accounts, no cloud, no metadata scraping (v1 — room to grow).

## AI assistance

This project was built with the help of an AI coding agent (Abacus.AI), working conversationally with the author across design, implementation, debugging, and testing — including the end-to-end LAN tests run from an Android phone. The author set the requirements, reviewed the code, and ran/reviewed every test; AI was not used at runtime. As with any dependency, the code is MIT-licensed and you're welcome to audit it before running it against your own library.

## Requirements

- Node.js **>= 18** (tested on 20.x), Windows or Linux.
- Zero runtime dependencies.

## Simple setup (start here)

Never run anything like this before? Four steps, about five minutes.

**1. Install Node.js — once per computer.**

Node.js is a runtime, the same kind of thing as Python: a program you install so the machine can run the code. OpenShelf is written in JavaScript and Node is what executes it. There is nothing else to install.

- Download the **LTS** installer: <https://nodejs.org/en/download>
- Windows: run the `.msi` and click through. It installs to `Program Files` and adds itself to PATH automatically — no checkbox to remember.
- Linux: use your package manager or the NodeSource instructions on that page.
- It also installs `npm`, Node's package manager. OpenShelf does not use it (zero dependencies), so you can ignore it.

Check it worked — open a terminal and run `node --version`. You should see `v18` or higher.

**2. Get OpenShelf.**

Download the source zip from the releases page: <https://github.com/Marusame00/OpenShelf/releases/latest> ("Source code (zip)"), then extract it anywhere — for example `C:\OpenShelf`. There is no installer and no build step.

**3. Point it at your media.**

You can do this from the web UI, or in the config file — either works, and you can mix them.

**Easiest — from the web UI.** Start OpenShelf (step 4), then in the sidebar click **+ Folder**, type or paste a path such as `D:/Media/Movies`, and press **Add**. The folder appears in the Libraries list immediately and is saved in `sortstore.json`, so it is still there next time you start. Remove one with the ✕ next to it. No restart, no file editing.

**Or in the config file.** In the extracted folder, copy `openshelf.config.example.json` to `openshelf.config.json` and edit the `roots` list:

```json
{
  "port": 8090,
  "roots": ["D:/Media/Movies", "D:/Media/Music", "D:/Pictures"]
}
```

Use forward slashes (`D:/Media`) or doubled backslashes (`D:\\Media`). Folders listed here are re-declared on every start and cannot be removed from the UI; folders added in the UI live in `sortstore.json` and can. If you skip this step entirely, OpenShelf serves its own folder so you can still look around.

**4. Run it.**

Double-click `start.bat`. It opens <http://localhost:8090> in your browser and serves your library. `stop.bat` shuts it down.

That is the whole install. No accounts, no database, no package install, no admin rights after step 1.

## Windows app (no command line)

If you would rather not run a `.bat` file, there are two Windows builds on the
[releases page](https://github.com/Marusame00/OpenShelf/releases/latest). Both
include `node.exe`, so **Node.js does not need to be installed**.

| Build | What it is |
|---|---|
| `OpenShelf-<version>-setup-win-x64.exe` | Installer: Start Menu shortcut, optional desktop shortcut and run-at-login, proper uninstaller. Installs per-user by default, so no admin prompt. |
| `OpenShelf-<version>-portable-win-x64.zip` | Unzip anywhere and run `OpenShelf.exe`. Nothing is written outside the folder except the thumbnail cache and log in `%LOCALAPPDATA%\OpenShelf`. |

`OpenShelf.exe` is a small tray launcher: it starts the server with no console
window, waits for the port, opens the browser, and puts an **OS** icon in the
notification area. Right-click it for **Open OpenShelf**, **Open app folder**,
**Open server log**, and **Stop and exit**. Double-click opens the UI again.

- It reads `openshelf.config.json` next to the exe if present, otherwise serves
  its own folder — same as `start.bat`.
- Server output goes to `%LOCALAPPDATA%\OpenShelf\logs\server.log`.
- Only one instance runs at a time; launching again just reopens the browser.
- The builds are unsigned, so Windows SmartScreen may show "Windows protected
  your PC" on first run: **More info → Run anyway**.

## Quick start

**Windows:** double-click `start.bat` — it opens the web UI in your browser and serves your library. Add folders with **+ Folder** in the sidebar, or list them in `openshelf.config.json` (copy the example first). `stop.bat` force-closes the server and frees its memory.

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
| GET | `/api/thumb?root=&path=&size=tn\|sm` | Cached JPEG thumbnail of an image (404 when the cache is off) |
| GET / PUT / DELETE | `/api/thumbs` | Cache status / `{enabled, maxMb}` settings (off clears it) / clear now |

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
src/thumbs.js        Optional thumbnail cache (size-capped, can be turned off)
start.bat / stop.bat Windows launcher: start with browser, force-stop
public/              index.html, app.js, style.css (no build step)
```

## DLNA / UPnP

Implemented: OpenShelf announces itself as a UPnP MediaServer and answers ContentDirectory Browse over SOAP, reusing the exact same library + per-folder sort logic as the web UI — so your saved sorts apply to DLNA clients too. **Verified on an Xbox Series X (Media Player app): discovered OpenShelf on the LAN and played files back directly.** Browse your library folders from any UPnP client; files stream with Range support through the same `/api/stream` endpoint (no transcoding).

- **Discovery**: SSDP on `239.255.255.250:1900` — responds to M-SEARCH (device, rootdevice, `ssdp:all`, UDN, and embedded service types) and sends NOTIFY alive every 60 s to the multicast group, the local broadcast address, and any IPs in `OSHELF_PEERS` (some APs/routers drop WiFi multicast — unicast NOTIFY bypasses that). On Windows the OS "SSDP Discovery" service (SSDPSRV) binds port 1900 first and Windows delivers multicast to only one socket; if a device doesn't see OpenShelf, stop that service from an admin prompt: `net stop SSDPSRV` (the known Windows fix; OpenShelf logs this hint at startup).
- Device description: `/upnp/device.xml`; services: ContentDirectory (`/upnp/control`) and ConnectionManager.
- Note: BubbleUPnP for Android was observed probing only service search types while missing device-type announcements; the service-type answers above fix that, but if a client still misses OpenShelf, use its ⋮ menu to add the server by URL: `http://<host>:8090/upnp/device.xml`.
- **Photos**: image items carry `resolution`, a DLNA profile (`JPEG_LRG`/`PNG_LRG` up to 1920x1200) and thumbnails (`/api/thumb`, 160px and 640px JPEG) cached on disk in the per-user cache folder (`%LOCALAPPDATA%\OpenShelf\thumbs` on Windows, `~/.cache/OpenShelf/thumbs` elsewhere; override with `--thumbs-dir`), invalidated when the file changes, size-capped and optional (see above). The resolved path is printed at startup. Originals are never modified. Resizing uses PowerShell/System.Drawing on Windows and ImageMagick (`convert`, or `OSHELF_MAGICK`) elsewhere; without it photos simply have no thumbnail. With these, the Xbox Media Player shows previews and offers "Set as background".
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
