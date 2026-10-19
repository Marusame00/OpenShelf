// src/config.js — CLI/environment configuration for OpenShelf.
//
// Precedence: command-line flags > environment variables (OSHELF_*) > defaults.
// Supports a JSON config file (--config) whose keys mirror the flags
// minus the ones given explicitly on the command line.

import fs from 'node:fs';
import path from 'node:path';

export function parseConfig(argv = process.argv.slice(2), env = process.env) {
  const cfg = {
    host: env.OSHELF_HOST || '0.0.0.0',
    port: parseInt(env.OSHELF_PORT || '8090', 10),
    roots: [],        // [{ id, path, name }]
    configFile: env.OSHELF_CONFIG || null,
    cacheTtlMs: parseInt(env.OSHELF_CACHE_TTL || '30000', 10),
    storeFile: env.OSHELF_STORE || 'sortstore.json',
    dataDir: env.OSHELF_DATA || null,
    upnp: env.OSHELF_UPNP !== 'off' && env.OSHELF_UPNP !== '0',
  };

  const flags = argv;

  // Config file first (lowest precedence of the explicit sources).
  const cfgIdx = flags.indexOf('--config');
  if (cfgIdx !== -1 && flags[cfgIdx + 1]) {
    cfg.configFile = flags[cfgIdx + 1];
  }
  if (cfg.configFile) {
    const fileCfg = JSON.parse(fs.readFileSync(cfg.configFile, 'utf8'));
  for (const k of ['host', 'port', 'roots', 'cacheTtlMs', 'storeFile', 'dataDir', 'upnp']) {
    if (fileCfg[k] !== undefined) cfg[k] = fileCfg[k];
  }
  }

  // Flat flags override the file.
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const val = () => flags[++i];
    if (f === '--port') cfg.port = parseInt(val(), 10);
    else if (f === '--host') cfg.host = val();
    else if (f === '--root') cfg.roots.push(atoRoot(val()));
    else if (f === '--cache-ttl') cfg.cacheTtlMs = parseInt(val(), 10);
    else if (f === '--store') cfg.storeFile = val();
    else if (f === '--data-dir') cfg.dataDir = val();
    else if (f === '--config') { i += 1; } // consumed above
    else if (f === '-h' || f === '--help') { cfg.help = true; }
  }

  // Roots given in the config file still need id/name derivation.
  cfg.roots = cfg.roots.map((r) => (typeof r === 'string' ? atoRoot(r) : r));

  // dataDir holds runtime files (store, logs). Default: next to the store.
  if (!cfg.dataDir) cfg.dataDir = path.dirname(path.resolve(cfg.storeFile));
  if (!cfg.storeFile) cfg.storeFile = path.resolve(cfg.dataDir, 'sortstore.json');

  if (cfg.roots.length === 0 && !cfg.help) {
    // A sensible dev default: if the user passed nothing, serve the current
    // working directory so `node server.js` is immediately useful.
    cfg.roots.push(atoRoot(process.cwd()));
  }
  return cfg;
}

export function printHelp() {
  console.log(`OpenShelf — self-hosted media server (no transcoding)

Usage: node server.js [flags]

  --root <path>     Add a library root folder (repeatable; required in v1)
  --port <n>        HTTP port              (default 8090, env OSHELF_PORT)
  --host <addr>     Bind address           (default 0.0.0.0, env OSHELF_HOST)
  --config <file>   JSON config file with keys: host, port, roots, cacheTtlMs,
                    storeFile, dataDir
  --cache-ttl <ms>  Directory cache lifetime (default 30000)
  --store <file>    Sort-preference store file (default sortstore.json)
  --data-dir <dir>  Directory for runtime files (default: store's dir)
  -h, --help        Show this help

Example:
  node server.js --root "C:/Media/Movies" --root "C:/Media/Music" --port 8090`);
}

function atoRoot(p) {
  const abs = path.resolve(p);
  // Normalise separators in the ID so clients can pass either / or \ without
  // caring about the platform's native separator.
  const id = abs.replace(/\\/g, '/').toLowerCase();
  return { id, path: abs, name: path.basename(abs) || abs };
}
