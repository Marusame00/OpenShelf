// server.js — OpenShelf entry point.
//
// Usage:
//   node server.js --root "C:/Media/Movies" --port 8090
// See `node server.js --help` or README.md for all options.

import fs from 'node:fs';
import { parseConfig, printHelp } from './src/config.js';
import { Library } from './src/library.js';
import { createApp } from './src/httpapp.js';

const cfg = parseConfig();
if (cfg.help) {
  printHelp();
  process.exit(0);
}

validateConfig(cfg);

const lib = new Library({ ttlMs: cfg.cacheTtlMs });

// Step 1 has no sort store yet: every folder uses the name/asc default.
// Step 2 injects a SortStore here and wires it to getSort().
const server = createApp({
  roots: cfg.roots,
  lib,
  ttlMs: cfg.cacheTtlMs,
  getSort: () => null,
});

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
