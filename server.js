// server.js — OpenShelf entry point.
//
// Usage:
//   node server.js --root "C:/Media/Movies" --port 8090
// See `node server.js --help` or README.md for all options.

import fs from 'node:fs';
import { parseConfig, printHelp } from './src/config.js';
import { Library } from './src/library.js';
import { createApp } from './src/httpapp.js';
import { SortStore } from './src/sortstore.js';
import { setupUpnp } from './src/upnp.js';

const cfg = parseConfig();
if (cfg.help) {
  printHelp();
  process.exit(0);
}

validateConfig(cfg);

const store = new SortStore({ file: cfg.storeFile });
await store.load();

// Runtime-managed roots (added via the GUI) survive restarts in the store;
// CLI/config-file roots are re-declared every start and cannot be removed
// through the UI.
const declaredRootIds = new Set(cfg.roots.map((r) => r.id));
const roots = [...cfg.roots, ...store.getRoots()];
const lib = new Library({ ttlMs: cfg.cacheTtlMs });

// Real UPnP/DLNA (MediaServer) — SSDP discovery + ContentDirectory SOAP.
// Failure here never blocks serving: DLNA is auxiliary to the web UI.
let upnpHandler = null;
if (cfg.upnp !== false) {
  try {
    upnpHandler = setupUpnp({ roots, lib, store, port: cfg.port, log: console });
  } catch (err) {
    console.warn(`[upnp] disabled: ${err.message}`);
  }
}

const server = createApp({ roots, declaredRootIds: [...declaredRootIds], lib, store, extra: upnpHandler });

server.listen(cfg.port, cfg.host, () => {
  console.log(`OpenShelf listening on http://${cfg.host}:${cfg.port}`);
  for (const r of cfg.roots) console.log(`  root: ${r.path}`);
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });

function validateConfig(cfg) {
  for (const r of cfg.roots) {
    if (!fs.existsSync(r.path)) {
      console.error(`Root does not exist: ${r.path}`);
      process.exit(1);
    }
  }
}
