# AGENTS.md — OpenShelf

Instructions for any agent (human or AI) working in this repository.

## What this project is

OpenShelf is a lightweight, self-hosted media server: direct byte-for-byte HTTP
streaming (no transcoding), per-folder sort memory with inheritance, a web UI,
and DLNA/UPnP for smart TVs/consoles. Zero npm runtime dependencies, Node.js
>= 18 (ESM), Windows + Linux. See `README.md` for user-facing docs.

## Layout

| Path | Purpose |
|---|---|
| `server.js` | CLI entry point: parses config, starts HTTP server + UPnP |
| `src/config.js` | CLI flag / env var / JSON config-file parsing |
| `src/httpapp.js` | All HTTP routes: browse, sort API, ranged `/api/stream`, static UI |
| `src/library.js` | Lazy directory cache (TTL + mtime), file classification, sort functions |
| `src/sortstore.js` | Per-folder sort persistence: atomic JSON writes, orphan (rename/move) adoption |
| `src/probe.js` | Zero-dependency mp4/mkv duration probing |
| `src/upnp.js` | SSDP discovery, SOAP ContentDirectory `Browse`, unicast NOTIFY fallback |
| `public/` | Web UI: `index.html`, `app.js`, `style.css` — no build step, no framework |
| `start.bat` / `stop.bat` | Windows launchers (open browser / force-kill by PID) |

## Build / check / run

- No build step and no package manager install (zero runtime deps). Syntax
  gate before manual testing: `node --check src/*.js server.js public/app.js`
- Run: `node server.js --root <folder> --port 8090` then open
  `http://localhost:8090`.
- Windows convenience: `start.bat` (opens browser + serves), `stop.bat`
  (`taskkill /F /PID <pid>` on the server process).
- No automated test suite exists yet — verification is done with `curl`
  against `/api/stream` (Range/HEAD/empty-file edge cases) and manual UI/DLNA
  checks on real hardware (Xbox, Android). When adding tests, prefer Node's
  built-in `node:test` to keep the zero-dependency promise.

## Conventions / gotchas (hard-won — see also the `zero-dep-media-server` skill)

- **Keep zero runtime dependencies.** Use only Node built-ins (`http`, `fs`,
  `dgram`, `crypto`, `path`). Do not add npm packages without discussing it —
  it's a stated project goal.
- **Every route/stream-sending helper must return a truthy value.** A
  falsy/undefined return makes the router fall through and write a second
  response → `ERR_HTTP_HEADERS_SENT`. `sendXml()` returns `true`; `send()` for
  streaming is `async` and resolves `true` only after the stream ends.
- **0-byte files**: `fs.createReadStream({start:0, end:-1})` throws
  `ERR_OUT_OF_RANGE`. `/api/stream` special-cases size-0 files with a direct
  `200`/`Content-Length: 0` response, for GET and Range alike. Don't regress
  this when touching `httpapp.js`'s streaming path.
- **Sort-store keys are canonical paths**: realpath, forward slashes,
  lowercase on Windows. Any new code reading/writing `sortstore.json` keys
  must normalize the same way or rename/case-sensitivity bugs reappear.
- **UPnP M-SEARCH must answer service-type searches** (`ContentDirectory:1`,
  `ConnectionManager:1`), not just device-type/`ssdp:all`/`rootdevice`/UDN —
  BubbleUPnP and similar strict clients search by service type; Xbox's
  client doesn't, so testing against one client hides gaps in the other.
- **WiFi multicast can silently fail** between a phone and this host even
  when unicast works fine. `OSHELF_PEERS` (space/comma-separated IPs) drives
  a periodic unicast SSDP NOTIFY to those addresses as the durable fallback —
  keep this working when touching `src/upnp.js`.
- `sortstore.json` at the repo root is a real runtime data file (not a
  fixture) — don't commit test-local versions over it; it's already
  `.gitignore`d pattern-wise where applicable, check before `git add -A`.
- avi/webm duration probing is not implemented (documented roadmap item in
  README) — don't claim duration support for those formats.

## Git / release process

- Conventional incremental commits, one feature/fix per commit (see
  `git log` for the message style used through v1.0.0).
- Releases are tagged (`vX.Y.Z`) and published via the GitHub API with release
  notes; disclose AI assistance in the README (already present) and in
  release notes.
- Public repo: https://github.com/Marusame00/OpenShelf (MIT license).

## Roadmap (not yet started — see summary of prior work for details)

1. avi/webm duration probes
2. Optional metadata scraping hook (title, year, artwork)
3. WebDAV support reusing the existing browse/stream logic
4. Consider SQLite for the sort store if `sortstore.json` grows unwieldy
5. Config UI for roots/defaults without a restart
