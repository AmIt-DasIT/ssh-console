// File and folder icons from VS Code's Material Icon Theme (PKief, MIT licence), resolved the way
// VS Code resolves an icon theme: exact file name first, then the longest matching extension
// (".d.ts" before ".ts"), then the default. Folders by name, with their open variant.
// The icons and the theme's manifest are served locally from node_modules/material-icon-theme.

let manifest = null;
let loading = null;
const listeners = new Set();

// A few names VS Code resolves through language detection rather than the manifest.
const EXTRA_EXT = { service: 'settings', socket: 'settings', timer: 'settings', mount: 'settings', conf: 'settings', cnf: 'settings', env: 'tune', bashrc: 'console', zshrc: 'console', profile: 'console' };

/** Load the manifest once. Resolves when icons are available (or null if they can't load). */
export function loadFileIcons() {
  loading ??= fetch('/vendor/file-icons.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
      manifest = m;
      for (const fn of listeners) fn();
      return m;
    })
    .catch(() => null);
  return loading;
}

/** Call fn once the icons are ready (immediately if they already are). */
export function onFileIcons(fn) {
  if (manifest) fn();
  else listeners.add(fn);
  loadFileIcons();
}

export const fileIconsReady = () => !!manifest;
const isLight = () => document.documentElement.dataset.theme === 'light';

function urlOf(id) {
  const def = id && manifest.iconDefinitions[id];
  if (!def) return null;
  return `/vendor/file-icons/${def.iconPath.split('/').pop()}`;
}

function pick(section, key) {
  if (isLight()) {
    const l = manifest.light?.[section]?.[key];
    if (l) return l;
  }
  return manifest[section]?.[key];
}

/** Icon URL for a file name, or null until the theme has loaded. */
export function fileIconUrl(name) {
  if (!manifest) return null;
  const lower = String(name).toLowerCase();
  let id = pick('fileNames', lower) || pick('fileNames', String(name));
  if (!id) {
    const parts = lower.split('.');
    for (let i = 1; i < parts.length && !id; i++) {
      const ext = parts.slice(i).join('.');
      id = pick('fileExtensions', ext) || (manifest.iconDefinitions[EXTRA_EXT[ext]] ? EXTRA_EXT[ext] : null);
    }
  }
  return urlOf(id || manifest.file);
}

/** Icon URL for a folder name (open = expanded variant), or null until the theme has loaded. */
export function folderIconUrl(name, open = false) {
  if (!manifest) return null;
  const key = String(name).toLowerCase();
  const id = pick(open ? 'folderNamesExpanded' : 'folderNames', key) || (open ? manifest.folderExpanded : manifest.folder);
  return urlOf(id);
}

/** <img> markup for an entry, or '' (caller falls back to its own icon). */
export function entryIconHtml(entry, { open = false, cls = 'fi' } = {}) {
  const url = entry.isDir ? folderIconUrl(entry.name, open) : fileIconUrl(entry.name);
  return url ? `<img class="${cls}" src="${url}" alt="" draggable="false" decoding="async" />` : '';
}
