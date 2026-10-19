// public/app.js — OpenShelf front-end.
// Plain vanilla JS (no build step, works in every modern browser).
//
// States: root list on the left, one folder open at a time in the middle.
// The sort bar shows the *effective* sort for the open folder; "Save for
// this folder" pins it as that folder's own pref, "Inherit" clears it.
// Manual order pins by storing a full row sequence and lets the user move
// entries up/down.

const SORT_KEYS = [
  ['name', 'Name'],
  ['mtime', 'Date modified'],
  ['added', 'Date added'],
  ['size', 'Size'],
  ['type', 'Type'],
  ['duration', 'Duration'],
  ['manual', 'Manual order'],
];
const ICO = {
  folder: '📁', video: '🎬', audio: '🎵', image: '🖼️', other: '📄',
};
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const state = {
  roots: [],          // from /api/roots
  root: null,         // selected root object
  path: '',           // relative path of the open folder ('' = root)
  folder: null,       // last /api/browse response
  manualDraft: null,  // [{name, isDir, ...}] working copy while arranging
  arranging: false,   // true while in manual-arrange mode
};

const el = (id) => document.getElementById(id);
const $ = el;

function qs(params) {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, v ?? ''])).toString();
}

function api(path, init) {
  return fetch(path, init).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error?.message || `HTTP ${r.status}`);
    return body;
  });
}

function streamUrl(name) {
  return `/api/stream?${qs({ root: state.root.id, path: join(state.path, name) })}`;
}

function join(a, b) {
  if (!a) return b;
  return a.replace(/\/+$/, '') + '/' + b;
}

function fmtSize(n) {
  if (n === null || n === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

function fmtDate(ms) {
  if (ms === null || ms === undefined) return '—';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---- roots ----------------------------------------------------------------

async function loadRoots() {
  const res = await api('/api/roots');
  state.roots = res.roots;
  const list = el('root-list');
  list.innerHTML = '';
  for (const r of res.roots) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'root-item';
    btn.dataset.id = r.id;
    btn.textContent = r.name + ' — ' + r.path;
    btn.title = r.path;
    btn.onclick = () => openRoot(r);
    li.appendChild(btn);
    const del = document.createElement('button');
    del.className = 'root-del';
    del.textContent = '✕';
    del.title = 'Remove this library';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove "${r.path}" from OpenShelf? (Files stay on disk.)`)) return;
      try {
        await api(`/api/roots?${qs({ id: r.id })}`, { method: 'DELETE' });
        await loadRoots();
        if (state.root && state.root.id === r.id) { state.root = null; state.path = ''; }
      } catch (err) { alert(err.message); }
    };
    li.appendChild(del);
    list.appendChild(li);
  }
  if (!state.root && state.roots.length) await openRoot(state.roots[0]);
}

el('btn-add-root').onclick = () => {
  el('add-root-form').classList.remove('hidden');
  el('add-root-path').focus();
};
el('add-root-cancel').onclick = () => el('add-root-form').classList.add('hidden');
el('add-root-form').onsubmit = async (e) => {
  e.preventDefault();
  const p = el('add-root-path').value.trim();
  if (!p) return;
  try {
    await api('/api/roots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
    el('add-root-path').value = '';
    el('add-root-form').classList.add('hidden');
    await loadRoots();
  } catch (err) {
    alert(`Could not add folder: ${err.message}`);
  }
};

// ---- navigation -----------------------------------------------------------

async function openRoot(root) {
  state.root = root;
  state.path = '';
  await loadFolder();
  await loadSortState();
  renderCrumbs();
  renderRootListActive();
}

async function openPath(rel) {
  state.path = rel || '';
  await loadFolder();
  await loadSortState();
  renderCrumbs();
}

function renderCrumbs() {
  const box = el('nav-crumbs');
  box.innerHTML = '';
  const home = document.createElement('a');
  home.className = 'crumb';
  home.textContent = state.root ? state.root.name : '—';
  home.onclick = () => openRoot(state.root);
  box.appendChild(home);
  if (!state.path) return;
  const parts = state.path.split('/');
  let acc = '';
  for (const dn of parts) {
    const sep = document.createElement('span');
    sep.className = 'crumb sep';
    sep.textContent = '›';
    box.appendChild(sep);
    const c = document.createElement('a');
    c.className = 'crumb';
    c.textContent = dn;
    acc = join(acc, dn);
    const target = acc; // capture per-iteration: `acc` mutates each loop
    if (acc === state.path) { c.classList.add('last'); }
    else c.onclick = () => openPath(target);
    box.appendChild(c);
  }
}

function renderRootListActive() {
  for (const li of el('root-list').children) {
    const btn = li.querySelector('.root-item');
    btn.classList.toggle('active', state.root !== null && btn.dataset.id === state.root.id);
  }
}

// ---- folder ---------------------------------------------------------------

async function loadFolder() {
  const box = el('entry-list');
  el('load-error').classList.add('hidden');
  el('empty-hint').classList.add('hidden');
  box.textContent = 'Loading…';
  try {
    const res = await api(`/api/browse?${qs({ root: state.root.id, path: state.path })}`);
    state.folder = res;
    state.arranging = false;
    exitArrangeUI();
    if (res.sort.key === 'manual') {
      el('folder-actions').classList.remove('hidden');
      el('btn-manual-done').textContent = 'Reorder';
      el('manual-hint').textContent = 'This folder uses a manual order. Click "Reorder" to change it.';
    }
    if (res.entries.length === 0) {
      el('empty-hint').classList.remove('hidden');
      box.textContent = '';
    } else {
      renderEntries(res.entries, false);
    }
  } catch (err) {
    box.textContent = '';
    const e = el('load-error');
    e.textContent = `Could not open this folder: ${err.message}`;
    e.classList.remove('hidden');
  }
}

function renderEntries(entries, manual) {
  const box = el('entry-list');
  box.classList.toggle('manual', manual);
  box.innerHTML = '';
  for (const e of entries) {
    const li = document.createElement('li');
    li.className = 'entry';
    if (!e.readable) li.classList.add('unreadable');
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.textContent = e.isDir ? ICO.folder : ICO[e.kind] || ICO.other;
    li.appendChild(ico);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = e.name;
    name.title = e.name;
    li.appendChild(name);
    const meta = document.createElement('span');
    meta.className = 'meta';
    const bits = [];
    if (!e.isDir) bits.push(`<span class="kind">${e.kind}</span> ${fmtSize(e.size)}`);
    else bits.push(`<span class="kind">dir</span>`);
    if (e.duration) bits.push(fmtDuration(e.duration));
    bits.push(fmtDate(e.mtimeMs));
    meta.innerHTML = bits.join(' · ');
    li.appendChild(meta);
    if (!e.readable) {
      const b = document.createElement('span');
      b.className = 'badge unreadable';
      b.textContent = e.error || 'unreadable';
      li.appendChild(b);
    } else if (e.link) {
      const b = document.createElement('span');
      b.className = 'badge symlink';
      b.textContent = 'link';
      li.appendChild(b);
    }
    if (e.isDir) {
      li.onclick = () => openPath(join(state.path, e.name));
    } else if (e.kind === 'video' || e.kind === 'audio' || e.kind === 'image') {
      li.onclick = () => openMedia(e);
    } else {
      const dl = document.createElement('a');
      dl.className = 'badge';
      dl.href = streamUrl(e.name);
      dl.textContent = 'download';
      dl.onclick = (ev) => ev.stopPropagation();
      li.appendChild(dl);
    }
    if (manual) appendArrows(li, e.name);
    box.appendChild(li);
  }
}

function appendArrows(li, name) {
  const arr = document.createElement('span');
  arr.className = 'arr';
  const up = document.createElement('button');
  up.textContent = '↑';
  up.onclick = (ev) => moveManual(name, -1, ev);
  const dn = document.createElement('button');
  dn.textContent = '↓';
  dn.onclick = (ev) => moveManual(name, +1, ev);
  arr.appendChild(up);
  arr.appendChild(dn);
  li.appendChild(arr);
}

function moveManual(name, delta, ev) {
  ev.stopPropagation();
  const idx = state.manualDraft.findIndex((e) => e.name === name);
  const target = idx + delta;
  if (idx < 0 || target < 0 || target >= state.manualDraft.length) return;
  const [m] = state.manualDraft.splice(idx, 1);
  state.manualDraft.splice(target, 0, m);
  renderEntries(state.manualDraft, true);
}

// ---- sort bar -------------------------------------------------------------

function fillKeySelect(sel, keys) {
  const existing = sel.value;
  sel.innerHTML = '';
  for (const [value, label] of keys) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  }
  if (existing) sel.value = existing;
}

async function loadSortState() {
  const res = await api(`/api/sort?${qs({ root: state.root.id, path: state.path })}`);
  fillKeySelect(el('sort-key'), SORT_KEYS);
  fillKeySelect(el('default-key'), SORT_KEYS.filter(([v]) => v !== 'manual'));
  el('default-dir').value = res.default.dir;
  el('default-key').value = res.default.key;
  const eff = res.effective.pref;
  el('sort-key').value = eff.key;
  el('sort-dir').value = eff.dir;
  renderOrigin(res.effective);
}

function renderOrigin(eff) {
  const span = el('sort-origin');
  span.classList.remove('folder', 'parent');
  if (eff.folder) {
    span.classList.add('folder');
    span.textContent = 'set for this folder';
  } else if (eff.origin) {
    span.classList.add('parent');
    span.textContent = `inherited from ${eff.origin}`;
  } else {
    span.textContent = 'using the global default';
  }
}

el('btn-save-sort').onclick = async () => {
  const key = el('sort-key').value;
  const dir = el('sort-dir').value;
  try {
    await api(`/api/sort?${qs({ root: state.root.id, path: state.path })}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, dir }),
    });
    await afterSortSaved();
  } catch (err) { alert(err.message); }
};

el('btn-reset-sort').onclick = async () => {
  try {
    await api(`/api/sort?${qs({ root: state.root.id, path: state.path })}`, { method: 'DELETE' });
    await afterSortSaved();
  } catch (err) { alert(err.message); }
};

async function afterSortSaved() {
  await loadFolder();
  await loadSortState();
}

// Manual-order interactions --------------------------------------------------

function enterArrange() {
  state.arranging = true;
  state.manualDraft = [...state.folder.entries.map((e) => ({ ...e }))];
  renderEntries(state.manualDraft, true);
  el('folder-actions').classList.remove('hidden');
  el('btn-manual-done').textContent = 'Save manual order';
  el('manual-hint').textContent = 'Move entries with the arrows, then save.';
}

function exitArrangeUI() {
  el('folder-actions').classList.add('hidden');
}

el('sort-key').onchange = () => {
  if (el('sort-key').value === 'manual') {
    enterArrange();
  } else if (state.arranging) {
    // User switched away mid-arrange: back to the server listing.
    state.arranging = false;
    exitArrangeUI();
    renderEntries(state.folder.entries, false);
  }
};

el('btn-manual-done').onclick = async () => {
  if (!state.arranging) {
    // "Reorder" — begins arrange mode on the current manual order.
    enterArrange();
    return;
  }
  const order = state.manualDraft.map((e) => e.name);
  try {
    await api(`/api/sort?${qs({ root: state.root.id, path: state.path })}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'manual', manualOrder: order }),
    });
    await afterSortSaved();
  } catch (err) { alert(err.message); }
};

async function loadDefault() {
  const res = await api('/api/default');
  fillKeySelect(el('default-key'), SORT_KEYS.filter(([v]) => v !== 'manual'));
  el('default-key').value = res.default.key;
  el('default-dir').value = res.default.dir;
}

el('default-key').onchange = saveDefault;
el('default-dir').onchange = saveDefault;

async function saveDefault() {
  try {
    await api('/api/default', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: el('default-key').value, dir: el('default-dir').value }),
    });
    await loadSortState();
  } catch (err) { alert(err.message); }
}

// ---- media modal ----------------------------------------------------------

function openMedia(entry) {
  const modal = el('player-modal');
  el('player-name').textContent = entry.name;
  const body = el('player-body');
  body.innerHTML = '';
  const url = streamUrl(entry.name);
  if (entry.kind === 'video') {
    const v = document.createElement('video');
    v.controls = true;
    v.autoplay = true;
    v.src = url;
    body.appendChild(v);
  } else if (entry.kind === 'audio') {
    const a = document.createElement('audio');
    a.controls = true;
    a.autoplay = true;
    a.src = url;
    body.appendChild(a);
  } else if (entry.kind === 'image') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = entry.name;
    body.appendChild(img);
  }
  const dl = document.createElement('div');
  dl.className = 'dl';
  const a = document.createElement('a');
  a.href = url;
  a.textContent = 'Save original file';
  dl.appendChild(a);
  body.appendChild(dl);
  modal.classList.remove('hidden');
}

el('player-close').onclick = () => {
  el('player-body').innerHTML = '';
  el('player-modal').classList.add('hidden');
};
el('player-modal').onclick = (e) => {
  if (e.target === el('player-modal')) el('player-close').onclick();
};

// ---- boot ----------------------------------------------------------------

function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

(async function boot() {
  fillKeySelect(el('sort-key'), SORT_KEYS);
  fillKeySelect(el('default-key'), SORT_KEYS.filter(([v]) => v !== 'manual'));
  await loadDefault();
  await loadRoots();
})();
