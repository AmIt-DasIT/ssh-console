// File manager for the SSH host and for containers: a gallery (grid with image thumbnails) and a
// list view, breadcrumbs, places and pins, search, sort, multi-select, drag & drop upload (files
// and whole folders), drag-to-move, rename, new folder / file, a text editor with save, image
// preview, folder sizes, downloads (one item, a folder or a selection as .tar) and delete.
// Every delete and every overwrite asks first, with a press-and-hold confirmation.
import { $, $$, esc, rpc, toast, fmtBytes, relTime, copyText, storage } from './core.js';
import { icon } from './icons.js';
import { confirmDialog, promptDialog } from './ui.js';
import { skeletonGrid, skeletonList } from './charts.js';
import * as transfers from './transfers.js';
import { entryIconHtml, folderIconUrl, onFileIcons } from './fileicons.js';
import { createCodeEditor } from './codeeditor.js';

// List-view columns. Name always shows; the rest are chosen by the user (Permissions and Owner are
// off by default) and drop automatically, last first, when the list is too narrow for them.
const COLUMNS = [
  { key: 'size', label: 'Size', width: 84, sort: 'size', cls: 'c-size num' },
  { key: 'mtime', label: 'Modified', width: 116, sort: 'mtime', cls: 'c-time' },
  { key: 'mode', label: 'Permissions', width: 102, cls: 'c-mode' },
  { key: 'owner', label: 'Owner', width: 92, cls: 'c-owner' },
];
const NAME_MIN = 200;
const colPrefs = () => ({ size: true, mtime: true, mode: false, owner: false, ...storage.get('sdc.fx.cols', {}) });

const join = (dir, name) => (dir.endsWith('/') ? dir : dir + '/') + name;
const parentOf = (p) => (p === '/' ? '/' : p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/');
const baseName = (p) => p.replace(/\/+$/, '').split('/').pop() || '/';
// ".bashrc" has no extension; ".env.local" has "local".
const extOf = (name) => (/\.([^./]+)$/.exec(String(name).replace(/^\.+/, ''))?.[1] || '').toLowerCase();
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MAX_RENDER = 2000;
const THUMB_MAX_BYTES = 4 * 1024 * 1024;
const EDIT_MAX_BYTES = 1024 * 1024;

// File kinds: icon + colour for gallery tiles.
const KIND_EXT = {
  image: 'png jpg jpeg gif webp svg bmp ico avif tiff tif heic',
  code: 'js mjs cjs ts tsx jsx py rb go rs java kt c h cc cpp hpp cs php sh bash zsh fish lua pl swift scala sql vue svelte css scss less html htm',
  config: 'json yaml yml toml ini conf cfg env properties xml plist service lock',
  text: 'txt md markdown rst csv tsv log out err nfo',
  archive: 'zip tar gz tgz bz2 xz zst 7z rar jar war deb rpm apk iso dmg',
  video: 'mp4 mkv mov avi webm m4v',
  audio: 'mp3 wav flac ogg m4a aac',
  pdf: 'pdf',
  db: 'db sqlite sqlite3 dump bak rdb aof',
  key: 'pem key crt cer csr pub p12 pfx gpg asc',
};
const EXT_KIND = new Map();
for (const [k, list] of Object.entries(KIND_EXT)) for (const e of list.split(' ')) EXT_KIND.set(e, k);
const KIND_ICON = {
  dir: 'folder', link: 'link', image: 'image', code: 'fileCode', config: 'settings', text: 'fileText', archive: 'archive',
  video: 'film', audio: 'music', pdf: 'fileText', db: 'database', key: 'key', file: 'file', exec: 'terminal',
};
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const TEXTISH = new Set(['code', 'config', 'text', 'file', 'exec', 'key', 'link']);

function kindOf(e) {
  if (e.isDir) return 'dir';
  const k = EXT_KIND.get(extOf(e.name));
  if (k) return k;
  if (/^(Dockerfile|Makefile|Procfile|Caddyfile|Jenkinsfile|Vagrantfile|\.?[\w-]*rc|\.gitignore|\.dockerignore|\.env(\..+)?)$/i.test(e.name)) return 'config';
  if (e.type === 'link') return 'link';
  if (/x/.test(String(e.mode).slice(1, 10)) && e.type === 'file') return 'exec';
  return 'file';
}

// ------------------------------------------------------------------ context menu (one, shared)

let ctxMenu = null;
function closeMenu() {
  ctxMenu?.remove();
  ctxMenu = null;
}
addEventListener('pointerdown', (e) => {
  if (ctxMenu && !ctxMenu.contains(e.target)) closeMenu();
}, true);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ctxMenu) {
    e.stopPropagation();
    closeMenu();
  }
}, true);
addEventListener('blur', closeMenu);
addEventListener('resize', closeMenu);

function openMenu(x, y, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'ctx-menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = items
    .map((it, i) =>
      it === '-'
        ? '<div class="ctx-sep"></div>'
        : `<button class="ctx-item${it.danger ? ' danger' : ''}" data-i="${i}" ${it.disabled ? 'disabled' : ''} role="menuitem">
            ${icon(it.icon || 'chevronRight')}<span>${esc(it.label)}</span>${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}</button>`,
    )
    .join('');
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  m.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  m.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b || b.disabled) return;
    const it = items[Number(b.dataset.i)];
    closeMenu();
    it.run();
  });
  ctxMenu = m;
  m.querySelector('.ctx-item:not([disabled])')?.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ folder upload helpers

/** Files from a drop, including the contents of dropped folders: [{ file, rel }] */
async function filesFromDrop(dt) {
  const items = [...(dt.items || [])].filter((i) => i.kind === 'file');
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])].map((file) => ({ file, rel: file.name }));
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, rel: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const en of entries) await walk(en, '');
  return out;
}

// ------------------------------------------------------------------ panel

const panels = new Set();
/** True while any file panel is uploading or has an unsaved edit (reload / disconnect ask first). */
export const unsavedWork = () => transfers.busy() || [...panels].some((p) => p.pv?.editing && p.pv?.dirty);

export class FilesPanel {
  /**
   * opts:
   *   target     'host' or { id } (container)
   *   startPath  first folder to open (when no remembered folder)
   *   places     [{ label, path, icon }] quick-access folders
   *   stateKey   key for remembering the folder / pins across reloads
   *   compact    narrow layout (side panel): list view by default, no places rail
   *   onTerminal (path) → open a terminal in that folder
   *   source     label for whose files these are (server name / container name)
   */
  constructor(mount, opts) {
    this.o = opts;
    this.t = opts.target === 'host' ? { target: 'host' } : { id: opts.target.id };
    this.isHost = opts.target === 'host';
    const saved = storage.get(`sdc.fx.path.${opts.stateKey}`, null);
    this.path = saved || opts.startPath || '/';
    this.entries = [];
    this.byName = new Map();
    this.view = []; // visible, sorted entries
    this.sel = new Set();
    this.anchor = null;
    this.back = [];
    this.fwd = [];
    this.loaded = false;
    this.loading = 0;
    this.thumbs = new Map(); // path|mtime -> dataURL | null
    this.thumbQueue = [];
    this.thumbBusy = 0;
    this.renderLimit = MAX_RENDER;
    const prefs = storage.get('sdc.fx', {});
    this.mode = prefs[opts.compact ? 'modeSide' : 'mode'] || (opts.compact ? 'list' : 'grid');
    this.sortKey = prefs.sortKey || 'name';
    this.sortDir = prefs.sortDir || 1;
    this.showHidden = prefs.hidden ?? true;
    this.pins = storage.get(`sdc.fx.pins.${opts.stateKey}`, []);
    this.tree = new Map(); // folder path -> names of its sub-folders (folder tree in the rail)
    this.expanded = new Set(['/']);

    const root = (this.root = document.createElement('div'));
    root.className = `fx${opts.compact ? ' compact' : ''}`;
    root.innerHTML = `
      <div class="fx-bar">
        <div class="fx-nav">
          <button class="icon-btn" data-act="back" title="Back">${icon('arrowLeft')}</button>
          <button class="icon-btn" data-act="fwd" title="Forward">${icon('arrowRight')}</button>
          <button class="icon-btn" data-act="up" title="Parent folder (${isMac ? '⌘↑' : 'Alt+↑'})">${icon('arrowUp')}</button>
        </div>
        <div class="fx-pathbox">
          <div class="fx-crumbs" title="Click a folder to open it · double-click to type a path"></div>
          <input class="fx-pathin mono" spellcheck="false" hidden />
          <button class="icon-btn fx-pathedit" data-act="edit-path" title="Type a path (${isMac ? '⌘' : 'Ctrl+'}L)">${icon('edit')}</button>
        </div>
        <div class="search-box sm fx-search">${icon('search')}<input type="search" placeholder="Filter this folder" /></div>
        <div class="fx-tools">
          <div class="seg seg-sm fx-mode">
            <button data-mode="grid" title="Gallery">${icon('grid')}</button>
            <button data-mode="list" title="List">${icon('list')}</button>
          </div>
          <button class="icon-btn" data-act="sort" title="Sort">${icon('sort')}</button>
          <button class="icon-btn" data-act="hidden" title="Show hidden files">${icon('eye')}</button>
          <button class="icon-btn" data-act="refresh" title="Refresh">${icon('refresh')}</button>
          <button class="btn small ghost" data-act="new">${icon('plus')}<span>New</span></button>
          <button class="btn small" data-act="upload">${icon('upload')}<span>Upload</span></button>
        </div>
        <input type="file" class="fx-in-files" multiple hidden />
        <input type="file" class="fx-in-dir" webkitdirectory multiple hidden />
      </div>
      <div class="fx-body">
        <nav class="fx-places"></nav>
        <div class="fx-main" tabindex="0">
          <div class="fx-content"></div>
          <div class="fx-drop"><div>${icon('upload')}<strong>Drop to upload</strong><span class="mono"></span></div></div>
        </div>
        <aside class="fx-preview" hidden></aside>
      </div>
      <div class="fx-foot">
        <span class="fx-src" title="${this.isHost ? 'Files on the server (VM) you are connected to' : 'Files inside this container'}">${icon(this.isHost ? 'server' : 'box')}<span>${esc(opts.source || (this.isHost ? 'Server' : 'Container'))}</span><em>${this.isHost ? 'server' : 'container'}</em></span>
        <span class="fx-count"></span>
        <span class="fx-selinfo"></span>
        <span class="spacer"></span>
        <div class="fx-selbar" hidden>
          <button class="btn small ghost" data-act="dl-sel">${icon('download')}<span>Download</span></button>
          <button class="btn small ghost" data-act="move-sel">${icon('move')}<span>Move</span></button>
          <button class="btn small danger-ghost" data-act="del-sel">${icon('trash')}<span>Delete</span></button>
          <button class="icon-btn" data-act="clear-sel" title="Clear selection (Esc)">${icon('x')}</button>
        </div>
      </div>`;
    mount.appendChild(root);

    this.main = $('.fx-main', root);
    this.content = $('.fx-content', root);
    panels.add(this);
    this.wire();
    onFileIcons(() => {
      if (!this.loaded) return;
      this.renderList();
      this.renderPlaces();
      this.paintPreviewIcon();
    });
    this.mainW = 0;
    new ResizeObserver(() => {
      const w = this.main.clientWidth;
      if (w === this.mainW) return;
      const before = this.visibleCols().map((c) => c.key).join();
      this.mainW = w;
      if (this.mode === 'list' && this.loaded && before !== this.visibleCols().map((c) => c.key).join()) this.renderList();
    }).observe(this.main);
    this.renderPlaces();
    this.syncTools();
  }

  // ---------------------------------------------------------------- wiring

  wire() {
    const root = this.root;
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('dblclick', (e) => this.onDblClick(e));
    root.addEventListener('contextmenu', (e) => this.onContext(e));
    $('.fx-search input', root).addEventListener('input', () => this.renderList());
    const pathIn = $('.fx-pathin', root);
    $('.fx-crumbs', root).addEventListener('dblclick', (e) => {
      if (e.target.closest('[data-crumb]')) return;
      this.editPath();
    });
    pathIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = pathIn.value.trim() || '/';
        this.endEditPath();
        this.open(v.startsWith('/') ? v : join(this.path, v));
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        this.endEditPath();
      }
    });
    pathIn.addEventListener('blur', () => this.endEditPath());
    $('.fx-in-files', root).addEventListener('change', (e) => {
      const list = [...e.target.files].map((file) => ({ file, rel: file.name }));
      e.target.value = '';
      this.upload(list, this.path);
    });
    $('.fx-in-dir', root).addEventListener('change', (e) => {
      const list = [...e.target.files].map((file) => ({ file, rel: file.webkitRelativePath || file.name }));
      e.target.value = '';
      this.upload(list, this.path);
    });
    this.main.addEventListener('keydown', (e) => this.onKey(e));

    // ---- drag & drop: files from the computer (upload) and items inside the panel (move)
    let depth = 0;
    const isExternal = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const isInternal = (e) => [...(e.dataTransfer?.types || [])].includes('application/x-sdc-paths');
    root.addEventListener('dragenter', (e) => {
      if (!isExternal(e) && !isInternal(e)) return;
      e.preventDefault();
      depth++;
      if (isExternal(e)) this.main.classList.add('dropping');
    });
    root.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        this.main.classList.remove('dropping', 'over-folder');
        this.clearDropTarget();
      }
    });
    root.addEventListener('dragover', (e) => {
      if (!isExternal(e) && !isInternal(e)) return;
      e.preventDefault();
      const folder = this.dropFolderAt(e.target);
      if (isInternal(e) && !folder) {
        e.dataTransfer.dropEffect = 'none';
        this.clearDropTarget();
        return;
      }
      e.dataTransfer.dropEffect = isInternal(e) ? 'move' : 'copy';
      this.setDropTarget(folder?.el || null);
      this.main.classList.toggle('over-folder', !!folder);
      $('.fx-drop span', root).textContent = folder ? folder.path : this.path;
    });
    root.addEventListener('drop', async (e) => {
      if (!isExternal(e) && !isInternal(e)) return;
      e.preventDefault();
      depth = 0;
      this.main.classList.remove('dropping', 'over-folder');
      const folder = this.dropFolderAt(e.target);
      this.clearDropTarget();
      if (isInternal(e)) {
        let paths = [];
        try {
          paths = JSON.parse(e.dataTransfer.getData('application/x-sdc-paths'));
        } catch { /* ignore */ }
        if (folder && paths.length) this.move(paths, folder.path);
        return;
      }
      const list = await filesFromDrop(e.dataTransfer);
      if (list.length) this.upload(list, folder ? folder.path : this.path);
      else toast('Nothing to upload (empty folders are skipped)', 'warn');
    });
    root.addEventListener('dragstart', (e) => {
      const it = e.target.closest?.('[data-name]');
      if (!it) return;
      const name = it.dataset.name;
      if (!this.sel.has(name)) this.select([name]);
      const paths = [...this.sel].map((n) => join(this.path, n));
      e.dataTransfer.setData('application/x-sdc-paths', JSON.stringify(paths));
      e.dataTransfer.setData('text/plain', paths.join('\n'));
      e.dataTransfer.effectAllowed = 'move';
      const ghost = document.createElement('div');
      ghost.className = 'fx-ghost';
      ghost.textContent = paths.length === 1 ? baseName(paths[0]) : `${paths.length} items`;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 10, 10);
      setTimeout(() => ghost.remove(), 0);
      root.classList.add('dragging-items');
    });
    root.addEventListener('dragend', () => root.classList.remove('dragging-items'));

    // Lazy thumbnails as tiles scroll into view.
    this.io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          this.io.unobserve(en.target);
          this.queueThumb(en.target);
        }
      },
      { root: this.content, rootMargin: '200px' },
    );
  }

  /** The folder (tile, row, crumb or place) under a drag, if any. */
  dropFolderAt(target) {
    const crumb = target.closest?.('[data-crumb]');
    if (crumb) return { el: crumb, path: crumb.dataset.crumb };
    const place = target.closest?.('[data-place]');
    if (place) return { el: place, path: place.dataset.place };
    const it = target.closest?.('[data-name]');
    if (it) {
      const en = this.byName.get(it.dataset.name);
      if (en?.isDir && !(this.root.classList.contains('dragging-items') && this.sel.has(en.name))) return { el: it, path: join(this.path, en.name) };
    }
    return null;
  }
  setDropTarget(el) {
    if (this.dropEl === el) return;
    this.dropEl?.classList.remove('drop-into');
    this.dropEl = el;
    el?.classList.add('drop-into');
  }
  clearDropTarget() {
    this.setDropTarget(null);
  }

  // ---------------------------------------------------------------- navigation

  show(v) {
    this.root.hidden = !v;
    if (v && !this.loaded && !this.loading) this.open(this.path, { initial: true });
  }

  async open(path, { initial = false, history = true, keepSel = false } = {}) {
    const token = ++this.loading;
    const prev = this.path;
    if (!this.loaded) this.content.innerHTML = this.mode === 'grid' ? skeletonGrid(this.o.compact ? 6 : 14) : skeletonList(this.o.compact ? 8 : 12);
    this.root.classList.add('busy');
    try {
      const res = await rpc('files.list', { ...this.t, path });
      if (token !== this.loading) return;
      if (history && this.loaded && res.path !== prev) {
        this.back.push(prev);
        if (this.back.length > 50) this.back.shift();
        this.fwd = [];
      }
      const changed = res.path !== this.path || !this.loaded;
      this.loaded = true;
      this.path = res.path;
      storage.set(`sdc.fx.path.${this.o.stateKey}`, this.path);
      this.entries = res.entries;
      this.byName = new Map(this.entries.map((e) => [e.name, e]));
      this.tree.set(this.path, this.entries.filter((e) => e.isDir).map((e) => e.name).sort(cmpNames));
      for (const a of ancestors(this.path)) this.expanded.add(a);
      if (changed) {
        $('.fx-search input', this.root).value = '';
        this.renderLimit = MAX_RENDER;
        this.content.scrollTop = 0;
      }
      if (!keepSel || changed) this.sel.clear();
      else for (const n of [...this.sel]) if (!this.byName.has(n)) this.sel.delete(n);
      this.renderCrumbs();
      this.renderPlaces();
      this.renderList(changed);
      this.revealTree();
    } catch (err) {
      if (token !== this.loading) return;
      if (initial && path !== '/' && !this.loaded) {
        // A remembered folder that no longer exists: fall back to the start folder, then "/".
        const next = path !== (this.o.startPath || '/') ? this.o.startPath || '/' : '/';
        return this.open(next, { initial: next !== '/' });
      }
      if (!this.loaded) {
        this.content.innerHTML = `<div class="fx-empty fx-error">
          <div class="fx-empty-art">${icon('alert')}</div>
          <strong>Couldn't open ${esc(path)}</strong>
          <span>${esc(err.message)}</span>
          <div class="fx-error-btns"><button class="btn small" data-act="retry">${icon('refresh')}Try again</button>${path !== '/' ? `<button class="btn small ghost" data-crumb="/">Open /</button>` : ''}</div>
        </div>`;
        this.path = path;
      } else toast(err.message, true);
    } finally {
      if (token === this.loading) {
        this.loading = 0;
        this.root.classList.remove('busy');
        this.syncTools();
      }
    }
  }

  refresh() {
    return this.open(this.path, { history: false, keepSel: true });
  }

  editPath() {
    const input = $('.fx-pathin', this.root);
    $('.fx-crumbs', this.root).hidden = true;
    $('.fx-pathedit', this.root).hidden = true;
    input.hidden = false;
    input.value = this.path;
    input.focus();
    input.select();
  }
  endEditPath() {
    $('.fx-pathin', this.root).hidden = true;
    $('.fx-crumbs', this.root).hidden = false;
    $('.fx-pathedit', this.root).hidden = false;
  }

  // ---------------------------------------------------------------- rendering

  renderCrumbs() {
    const segs = this.path.split('/').filter(Boolean);
    let acc = '';
    const parts = [`<button class="fx-crumb root" data-crumb="/" title="/">${icon(this.isHost ? 'server' : 'box')}</button>`];
    for (const s of segs) {
      acc += `/${s}`;
      parts.push(`<span class="fx-sep">${icon('chevronRight')}</span><button class="fx-crumb" data-crumb="${esc(acc)}">${esc(s)}</button>`);
    }
    const el = $('.fx-crumbs', this.root);
    el.innerHTML = parts.join('');
    el.lastElementChild?.classList.add('current');
    el.scrollLeft = el.scrollWidth;
  }

  /** Load the sub-folders of every folder above the current one, so the tree can show the path. */
  async revealTree() {
    if (this.o.compact || this.revealing) return;
    this.revealing = true;
    try {
      for (const a of ancestors(this.path)) {
        if (this.tree.has(a)) continue;
        const res = await rpc('files.list', { ...this.t, path: a }).catch(() => null);
        this.tree.set(a, res ? res.entries.filter((e) => e.isDir).map((e) => e.name).sort(cmpNames) : []);
        this.renderPlaces();
      }
    } finally {
      this.revealing = false;
    }
  }

  async toggleNode(path) {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      return this.renderPlaces();
    }
    this.expanded.add(path);
    if (!this.tree.has(path)) {
      this.renderPlaces(path);
      try {
        const res = await rpc('files.list', { ...this.t, path });
        this.tree.set(path, res.entries.filter((e) => e.isDir).map((e) => e.name).sort(cmpNames));
      } catch (err) {
        this.tree.set(path, []);
        toast(err.message, true);
      }
    }
    this.renderPlaces();
  }

  treeHtml(loadingPath) {
    const rows = [];
    const node = (full, name, depth) => {
      const open = this.expanded.has(full);
      const kids = this.tree.get(full);
      const leaf = kids && !kids.filter((n) => this.showHidden || !n.startsWith('.')).length;
      const busy = loadingPath === full;
      rows.push(`<button class="fx-place fx-node${full === this.path ? ' active' : ''}" data-place="${esc(full)}" title="${esc(full)}" style="--d:${depth}">
        <span class="fx-twist${open && !leaf ? ' open' : ''}${leaf ? ' leaf' : ''}" data-twist="${esc(full)}">${icon(busy ? 'refresh' : 'chevronRight', busy ? 'spinning' : '')}</span>${full === '/' ? icon(this.isHost ? 'server' : 'box') : treeIcon(name, open && !leaf)}<span>${esc(name)}</span></button>`);
      if (!open || !kids) return;
      const shown = kids.filter((n) => this.showHidden || !n.startsWith('.'));
      for (const n of shown.slice(0, 400)) node(join(full, n), n, depth + 1);
      if (shown.length > 400) rows.push(`<div class="fx-node-more" style="--d:${depth + 1}">… ${shown.length - 400} more</div>`);
    };
    node('/', '/', 0);
    return rows.join('');
  }

  renderPlaces(loadingPath) {
    const el = $('.fx-places', this.root);
    const scroll = el.scrollTop;
    const item = (p, extra = '') =>
      `<button class="fx-place${p.path === this.path ? ' active' : ''}" data-place="${esc(p.path)}" title="${esc(p.path)}">${icon(p.icon || 'folder')}<span>${esc(p.label)}</span>${extra}</button>`;
    const places = this.o.places || [];
    el.innerHTML =
      `<div class="fx-place-h">Places</div>${places.map((p) => item(p)).join('')}` +
      (this.pins.length
        ? `<div class="fx-place-h">Pinned</div>${this.pins
            .map((p) => item({ label: baseName(p) || '/', path: p, icon: 'pin' }, `<span class="fx-unpin" data-unpin="${esc(p)}" title="Unpin">${icon('x')}</span>`))
            .join('')}`
        : '') +
      (this.o.compact ? '' : `<div class="fx-place-h">Folders</div><div class="fx-tree">${this.treeHtml(loadingPath)}</div>`);
    el.scrollTop = scroll;
    const act = el.querySelector('.fx-node.active');
    if (act && this.lastRevealed !== this.path) {
      this.lastRevealed = this.path;
      act.scrollIntoView({ block: 'nearest' });
    }
  }

  sorted(list) {
    const k = this.sortKey;
    const d = this.sortDir;
    const cmpName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return [...list].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let r = 0;
      if (k === 'size') r = (a.isDir ? 0 : a.size) - (b.isDir ? 0 : b.size);
      else if (k === 'mtime') r = a.mtime - b.mtime;
      else if (k === 'type') r = extOf(a.name).localeCompare(extOf(b.name));
      return (r || cmpName(a, b)) * d;
    });
  }

  renderList(animate = false) {
    const q = $('.fx-search input', this.root).value.trim().toLowerCase();
    let list = this.entries.filter((e) => (this.showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)));
    list = this.sorted(list);
    this.view = list;
    const shown = list.slice(0, this.renderLimit);
    const more = list.length > shown.length
      ? `<div class="fx-more-row"><button class="btn small" data-act="show-all">Show all ${list.length} items</button></div>`
      : '';

    let html;
    if (!list.length) {
      html = `<div class="fx-empty">
        <div class="fx-empty-art">${icon(q ? 'search' : 'folderOpen')}</div>
        <strong>${q ? 'No matches' : 'This folder is empty'}</strong>
        <span>${q ? `Nothing here matches “${esc(q)}”.` : 'Drop files or folders here to upload them.'}</span>
        ${q ? '' : `<button class="btn small" data-act="upload">${icon('upload')}Upload files</button>`}
      </div>`;
    } else if (this.mode === 'grid') {
      html = `<div class="fx-grid${animate ? ' animate-in' : ''}">${shown.map((e, i) => this.tile(e, i)).join('')}</div>${more}`;
    } else {
      const th = (k, label, cls = '') =>
        k
          ? `<button class="fx-th ${cls}${this.sortKey === k ? ' on' : ''}" data-sort="${k}">${label}${this.sortKey === k ? `<i>${this.sortDir > 0 ? '▲' : '▼'}</i>` : ''}</button>`
          : `<span class="fx-th ${cls}">${label}</span>`;
      const cols = this.visibleCols();
      this.cols = cols;
      html = `<div class="fx-list${animate ? ' animate-in' : ''}" style="--fx-cols:minmax(0,1fr) ${cols.map((c) => `${c.width}px`).join(' ')} 34px">
        <div class="fx-row fx-head">${th('name', 'Name', 'c-name')}${cols.map((c) => th(c.sort, c.label, c.cls)).join('')}<span class="c-more"><button class="icon-btn fx-colbtn" data-act="columns" title="Choose columns">${icon('columns')}</button></span></div>
        ${shown.map((e, i) => this.row(e, i)).join('')}</div>${more}`;
    }
    this.content.innerHTML = html;
    if (this.mode === 'grid') for (const t of $$('.fx-thumb[data-img]', this.content)) this.io.observe(t);
    clearTimeout(this.animT);
    if (animate) this.animT = setTimeout(() => $('.animate-in', this.content)?.classList.remove('animate-in'), 900);
    this.renderFoot();
  }

  metaLine(e) {
    const when = e.mtime ? relTime(new Date(e.mtime * 1000)) : '';
    if (e.isDir) return e.type === 'link' ? `Link · ${when}` : when;
    return `${fmtBytes(e.size)} · ${when}`;
  }

  tile(e, i) {
    const kind = kindOf(e);
    const sel = this.sel.has(e.name);
    const full = join(this.path, e.name);
    const img = kind === 'image' && IMAGE_EXT.has(extOf(e.name)) && e.size > 0 && e.size <= THUMB_MAX_BYTES;
    const cached = img ? this.thumbs.get(`${full}|${e.mtime}`) : undefined;
    const inner = cached ? `<img src="${cached}" alt="" draggable="false" />` : entryIconHtml(e) || icon(KIND_ICON[kind]);
    return `<div class="fx-tile k-${kind}${sel ? ' sel' : ''}${e.name.startsWith('.') ? ' dim' : ''}" data-name="${esc(e.name)}" draggable="true" style="--i:${Math.min(i, 40)}" title="${esc(e.name)}">
      <div class="fx-thumb${cached ? ' has-img' : ''}"${img && !cached ? ` data-img="${esc(full)}" data-mtime="${e.mtime}"` : ''}>${inner}${e.type === 'link' ? `<span class="fx-linkbadge">${icon('link')}</span>` : ''}</div>
      <div class="fx-name">${esc(e.name)}</div>
      <div class="fx-meta">${esc(this.metaLine(e))}</div>
      <span class="fx-check">${icon('tick')}</span>
      <button class="fx-more icon-btn" data-act="more" title="Actions">${icon('more')}</button>
    </div>`;
  }

  row(e, i) {
    const kind = kindOf(e);
    return `<div class="fx-row k-${kind}${this.sel.has(e.name) ? ' sel' : ''}${e.name.startsWith('.') ? ' dim' : ''}" data-name="${esc(e.name)}" draggable="true" style="--i:${Math.min(i, 40)}">
      <span class="c-name"><span class="fx-ricon">${entryIconHtml(e) || icon(KIND_ICON[kind])}</span><span class="fx-rname" title="${esc(e.name)}">${esc(e.name)}</span>${e.type === 'link' ? `<span class="fx-tag">link</span>` : ''}</span>
      ${(this.cols || []).map((c) => this.cell(c.key, e)).join('')}
      <span class="c-more"><button class="icon-btn" data-act="more" title="Actions">${icon('more')}</button></span>
    </div>`;
  }

  cell(key, e) {
    switch (key) {
      case 'size': return `<span class="c-size num">${e.isDir ? '<span class="muted">—</span>' : fmtBytes(e.size)}</span>`;
      case 'mtime': return `<span class="c-time muted" title="${e.mtime ? esc(new Date(e.mtime * 1000).toLocaleString()) : ''}">${e.mtime ? esc(relTime(new Date(e.mtime * 1000))) : ''}</span>`;
      case 'mode': return `<span class="c-mode mono muted">${esc(e.mode)}</span>`;
      case 'owner': return `<span class="c-owner muted">${esc(e.owner)}</span>`;
    }
    return '';
  }

  /** Chosen columns that fit next to a readable name column. */
  visibleCols() {
    const on = colPrefs();
    let room = (this.mainW || this.main.clientWidth || 1000) - 12 - 16 - 34 - NAME_MIN;
    const out = [];
    for (const c of COLUMNS) {
      if (!on[c.key]) continue;
      if (room < c.width + 8) break;
      room -= c.width + 8;
      out.push(c);
    }
    return out;
  }

  columnsMenu(x, y) {
    const on = colPrefs();
    const shown = new Set(this.visibleCols().map((c) => c.key));
    openMenu(x, y, COLUMNS.map((c) => ({
      label: `${c.label}${on[c.key] && !shown.has(c.key) ? ' (no room — widen the list)' : ''}`,
      icon: on[c.key] ? 'checkSquare' : 'square',
      run: () => {
        storage.set('sdc.fx.cols', { ...on, [c.key]: !on[c.key] });
        for (const p of panels) if (p.loaded && p.mode === 'list') p.renderList();
      },
    })));
  }

  renderFoot() {
    const dirs = this.view.filter((e) => e.isDir).length;
    const files = this.view.length - dirs;
    const bytes = this.view.reduce((s, e) => s + (e.isDir ? 0 : e.size || 0), 0);
    $('.fx-count', this.root).textContent = `${dirs} folder${dirs === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'}${files ? ` · ${fmtBytes(bytes)}` : ''}`;
    const n = this.sel.size;
    const selBytes = [...this.sel].reduce((s, name) => {
      const e = this.byName.get(name);
      return s + (e && !e.isDir ? e.size || 0 : 0);
    }, 0);
    $('.fx-selinfo', this.root).textContent = n ? `${n} selected${selBytes ? ` · ${fmtBytes(selBytes)}` : ''}` : '';
    $('.fx-selbar', this.root).hidden = !n;
  }

  /** Update selection classes without re-rendering. */
  paintSel() {
    for (const el of $$('[data-name]', this.content)) el.classList.toggle('sel', this.sel.has(el.dataset.name));
    this.renderFoot();
  }

  select(names, { add = false } = {}) {
    if (!add) this.sel.clear();
    for (const n of names) this.sel.add(n);
    this.paintSel();
  }

  syncTools() {
    const r = this.root;
    $('[data-act="back"]', r).disabled = !this.back.length;
    $('[data-act="fwd"]', r).disabled = !this.fwd.length;
    $('[data-act="up"]', r).disabled = this.path === '/';
    $$('.fx-mode button', r).forEach((b) => b.classList.toggle('active', b.dataset.mode === this.mode));
    const hb = $('[data-act="hidden"]', r);
    hb.innerHTML = icon(this.showHidden ? 'eye' : 'eyeOff');
    hb.title = this.showHidden ? 'Hide hidden files' : 'Show hidden files';
    hb.classList.toggle('on', !this.showHidden);
  }

  savePrefs() {
    const p = storage.get('sdc.fx', {});
    p[this.o.compact ? 'modeSide' : 'mode'] = this.mode;
    Object.assign(p, { sortKey: this.sortKey, sortDir: this.sortDir, hidden: this.showHidden });
    storage.set('sdc.fx', p);
  }

  // ---------------------------------------------------------------- thumbnails

  queueThumb(el) {
    this.thumbQueue.push(el);
    this.pumpThumbs();
  }

  async pumpThumbs() {
    while (this.thumbBusy < 3 && this.thumbQueue.length) {
      const el = this.thumbQueue.shift();
      if (!el.isConnected || !el.dataset.img) continue;
      this.thumbBusy++;
      const path = el.dataset.img;
      const key = `${path}|${el.dataset.mtime}`;
      rpc('files.image', { ...this.t, path, limit: THUMB_MAX_BYTES })
        .then((r) => {
          const url = r.tooLarge ? null : `data:${r.mime};base64,${r.data}`;
          this.thumbs.set(key, url);
          if (this.thumbs.size > 400) this.thumbs.delete(this.thumbs.keys().next().value);
          if (url && el.isConnected) {
            const img = new Image();
            img.alt = '';
            img.draggable = false;
            img.onload = () => {
              if (!el.isConnected) return;
              el.querySelectorAll(':scope > svg, :scope > em, :scope > img.fi').forEach((x) => x.remove());
              el.prepend(img);
              el.classList.add('has-img', 'img-in');
            };
            img.src = url;
          }
        })
        .catch(() => this.thumbs.set(key, null))
        .finally(() => {
          this.thumbBusy--;
          this.pumpThumbs();
        });
    }
  }

  // ---------------------------------------------------------------- events

  entryOf(el) {
    const it = el?.closest?.('[data-name]');
    return it ? this.byName.get(it.dataset.name) : null;
  }

  onClick(e) {
    const actEl = e.target.closest('[data-act]');
    const act = actEl?.dataset.act;
    if (e.target.closest('[data-unpin]')) {
      const p = e.target.closest('[data-unpin]').dataset.unpin;
      this.pins = this.pins.filter((x) => x !== p);
      storage.set(`sdc.fx.pins.${this.o.stateKey}`, this.pins);
      return this.renderPlaces();
    }
    const twist = e.target.closest('[data-twist]');
    if (twist) return this.toggleNode(twist.dataset.twist);
    const crumb = e.target.closest('[data-crumb]');
    if (crumb) return this.open(crumb.dataset.crumb);
    const place = e.target.closest('[data-place]');
    if (place) return this.open(place.dataset.place);
    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn) {
      this.mode = modeBtn.dataset.mode;
      this.savePrefs();
      this.syncTools();
      return this.renderList(true);
    }
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      const k = sortBtn.dataset.sort;
      this.sortDir = this.sortKey === k ? -this.sortDir : 1;
      this.sortKey = k;
      this.savePrefs();
      return this.renderList();
    }
    switch (act) {
      case 'back':
        if (this.back.length) {
          this.fwd.push(this.path);
          return this.open(this.back.pop(), { history: false });
        }
        return;
      case 'fwd':
        if (this.fwd.length) {
          this.back.push(this.path);
          return this.open(this.fwd.pop(), { history: false });
        }
        return;
      case 'up': return this.open(parentOf(this.path));
      case 'edit-path': return this.editPath();
      case 'refresh': return this.refresh();
      case 'retry': return this.open(this.path, { history: false });
      case 'hidden':
        this.showHidden = !this.showHidden;
        this.savePrefs();
        this.syncTools();
        this.renderPlaces();
        return this.renderList();
      case 'sort': return this.sortMenu(actEl);
      case 'columns': {
        const r = actEl.getBoundingClientRect();
        return this.columnsMenu(r.right - 220, r.bottom + 4);
      }
      case 'new': return this.newMenu(actEl);
      case 'upload': return this.uploadMenu(actEl);
      case 'show-all':
        this.renderLimit = Infinity;
        return this.renderList();
      case 'dl-sel': return this.download([...this.sel].map((n) => join(this.path, n)));
      case 'move-sel': return this.moveTo([...this.sel].map((n) => join(this.path, n)));
      case 'del-sel': return this.remove([...this.sel].map((n) => join(this.path, n)));
      case 'clear-sel': return this.select([]);
      case 'more': {
        const en = this.entryOf(actEl);
        if (en && !this.sel.has(en.name)) this.select([en.name]);
        const b = actEl.getBoundingClientRect();
        return this.itemMenu(b.left, b.bottom + 4);
      }
      case 'pv-close': return this.closePreview();
      case 'pv-edit': return this.startEdit();
      case 'pv-save': return this.saveEdit();
      case 'pv-copy': return copyText(this.pvValue() ?? this.pv?.text ?? '', 'File contents copied');
      case 'pv-dl': return this.pv && this.download([this.pv.path]);
    }
    if (e.target.closest('.fx-preview, .fx-bar, .fx-foot, .fx-places')) return;

    // Selection clicks on tiles/rows.
    const en = this.entryOf(e.target);
    this.main.focus({ preventScroll: true });
    if (!en) {
      if (e.target.closest('.fx-main') && !e.metaKey && !e.ctrlKey && !e.shiftKey) this.select([]);
      return;
    }
    const idx = this.view.indexOf(en);
    if (e.shiftKey && this.anchor !== null) {
      const a = Math.min(this.anchor, idx);
      const b = Math.max(this.anchor, idx);
      this.select(this.view.slice(a, b + 1).map((x) => x.name), { add: e.metaKey || e.ctrlKey });
    } else if (e.metaKey || e.ctrlKey) {
      this.sel.has(en.name) ? this.sel.delete(en.name) : this.sel.add(en.name);
      this.anchor = idx;
      this.paintSel();
    } else {
      this.anchor = idx;
      this.select([en.name]);
      // With the preview open, it follows the selection.
      // (Only unsaved edits hold it on the current file.)
      if (this.pv && !en.isDir && !(this.pv.editing && this.pv.dirty)) this.preview(join(this.path, en.name), en);
    }
  }

  onDblClick(e) {
    if (e.target.closest('.fx-preview, .fx-bar, .fx-foot, [data-act]')) return;
    const en = this.entryOf(e.target);
    if (en) this.openEntry(en);
  }

  openEntry(en) {
    const full = join(this.path, en.name);
    if (en.isDir) return this.open(full);
    return this.preview(full, en);
  }

  onContext(e) {
    if (e.target.closest('.fx-preview textarea, input')) return;
    const inMain = e.target.closest('.fx-main');
    if (!inMain) return;
    e.preventDefault();
    if (e.target.closest('.fx-head')) return this.columnsMenu(e.clientX, e.clientY);
    const en = this.entryOf(e.target);
    if (en) {
      if (!this.sel.has(en.name)) {
        this.anchor = this.view.indexOf(en);
        this.select([en.name]);
      }
      return this.itemMenu(e.clientX, e.clientY);
    }
    this.select([]);
    openMenu(e.clientX, e.clientY, [
      { label: 'New folder…', icon: 'folderPlus', run: () => this.newFolder() },
      { label: 'New file…', icon: 'filePlus', run: () => this.newFile() },
      '-',
      { label: 'Upload files…', icon: 'upload', run: () => $('.fx-in-files', this.root).click() },
      { label: 'Upload a folder…', icon: 'folder', run: () => $('.fx-in-dir', this.root).click() },
      '-',
      { label: 'Download this folder (.tar)', icon: 'download', run: () => this.download([this.path], true) },
      { label: 'Folder size', icon: 'gauge', run: () => this.measure(this.path) },
      ...(this.o.onTerminal ? [{ label: 'Open in terminal', icon: 'terminal', run: () => this.o.onTerminal(this.path) }] : []),
      { label: this.pins.includes(this.path) ? 'Unpin this folder' : 'Pin this folder', icon: 'pin', run: () => this.togglePin(this.path) },
      { label: 'Copy path', icon: 'copy', run: () => copyText(this.path, 'Path copied') },
      '-',
      { label: 'Select all', icon: 'checkSquare', kbd: isMac ? '⌘A' : 'Ctrl+A', run: () => this.select(this.view.map((x) => x.name)) },
      { label: 'Refresh', icon: 'refresh', run: () => this.refresh() },
    ]);
  }

  itemMenu(x, y) {
    const names = [...this.sel];
    if (!names.length) return;
    const paths = names.map((n) => join(this.path, n));
    const one = names.length === 1 ? this.byName.get(names[0]) : null;
    const mod = isMac ? '⌘' : 'Ctrl+';
    const items = [];
    if (one) {
      items.push({ label: one.isDir ? 'Open' : 'Preview', icon: one.isDir ? 'folderOpen' : 'eye', kbd: '↵', run: () => this.openEntry(one) });
      if (!one.isDir && TEXTISH.has(kindOf(one)) && one.size <= EDIT_MAX_BYTES) {
        items.push({ label: 'Edit', icon: 'edit', run: () => this.preview(paths[0], one, { edit: true }) });
      }
      items.push('-');
      items.push({ label: 'Rename…', icon: 'edit', kbd: 'F2', run: () => this.rename(paths[0]) });
    }
    items.push({ label: names.length > 1 ? `Download ${names.length} items (.tar)` : one?.isDir ? 'Download (.tar)' : 'Download', icon: 'download', run: () => this.download(paths) });
    items.push({ label: 'Move to…', icon: 'move', run: () => this.moveTo(paths) });
    if (one?.isDir) {
      items.push({ label: 'Folder size', icon: 'gauge', run: () => this.measure(paths[0]) });
      if (this.o.onTerminal) items.push({ label: 'Open in terminal', icon: 'terminal', run: () => this.o.onTerminal(paths[0]) });
      items.push({ label: this.pins.includes(paths[0]) ? 'Unpin' : 'Pin to places', icon: 'pin', run: () => this.togglePin(paths[0]) });
    }
    items.push({ label: names.length > 1 ? 'Copy paths' : 'Copy path', icon: 'copy', run: () => copyText(paths.join('\n'), names.length > 1 ? 'Paths copied' : 'Path copied') });
    items.push('-');
    items.push({ label: names.length > 1 ? `Delete ${names.length} items…` : 'Delete…', icon: 'trash', danger: true, kbd: `${mod}⌫`, run: () => this.remove(paths) });
    openMenu(x, y, items);
  }

  sortMenu(btn) {
    const b = btn.getBoundingClientRect();
    const opt = (k, label) => ({
      label: `${label}${this.sortKey === k ? (this.sortDir > 0 ? '  ↑' : '  ↓') : ''}`,
      icon: this.sortKey === k ? 'check' : 'sort',
      run: () => {
        this.sortDir = this.sortKey === k ? -this.sortDir : 1;
        this.sortKey = k;
        this.savePrefs();
        this.renderList();
      },
    });
    openMenu(b.left, b.bottom + 4, [opt('name', 'Name'), opt('mtime', 'Date modified'), opt('size', 'Size'), opt('type', 'Type')]);
  }

  newMenu(btn) {
    const b = btn.getBoundingClientRect();
    openMenu(b.left, b.bottom + 4, [
      { label: 'New folder…', icon: 'folderPlus', run: () => this.newFolder() },
      { label: 'New file…', icon: 'filePlus', run: () => this.newFile() },
    ]);
  }

  uploadMenu(btn) {
    const b = btn.getBoundingClientRect();
    openMenu(b.left, b.bottom + 4, [
      { label: 'Upload files…', icon: 'upload', run: () => $('.fx-in-files', this.root).click() },
      { label: 'Upload a folder…', icon: 'folder', run: () => $('.fx-in-dir', this.root).click() },
    ]);
  }

  onKey(e) {
    if (e.target.closest('input, textarea')) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key;
    if (mod && key.toLowerCase() === 'l') {
      e.preventDefault();
      return this.editPath();
    }
    if (mod && key.toLowerCase() === 'a') {
      e.preventDefault();
      return this.select(this.view.map((x) => x.name));
    }
    if (key === 'Escape' && this.sel.size) {
      e.preventDefault();
      e.stopPropagation();
      return this.select([]);
    }
    if ((key === 'Delete' || (key === 'Backspace' && mod)) && this.sel.size) {
      e.preventDefault();
      return this.remove([...this.sel].map((n) => join(this.path, n)));
    }
    if ((key === 'ArrowUp' && (mod || e.altKey)) || (key === 'Backspace' && !this.sel.size)) {
      e.preventDefault();
      return this.open(parentOf(this.path));
    }
    if (key === 'F2' && this.sel.size === 1) {
      e.preventDefault();
      return this.rename(join(this.path, [...this.sel][0]));
    }
    if (key === 'Enter' && this.sel.size === 1) {
      e.preventDefault();
      const en = this.byName.get([...this.sel][0]);
      if (en) this.openEntry(en);
      return;
    }
    if (key === ' ' && this.sel.size === 1) {
      e.preventDefault();
      const en = this.byName.get([...this.sel][0]);
      if (this.pv && this.pv.path === join(this.path, en.name)) return this.closePreview();
      if (en && !en.isDir) this.preview(join(this.path, en.name), en);
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key) && this.view.length) {
      e.preventDefault();
      const cur = this.anchor ?? -1;
      let cols = 1;
      if (this.mode === 'grid') {
        const tiles = $$('.fx-tile', this.content);
        const top = tiles[0]?.offsetTop;
        cols = Math.max(1, tiles.findIndex((t) => t.offsetTop !== top));
        if (cols <= 0) cols = tiles.length;
      }
      let next = cur;
      if (key === 'Home') next = 0;
      else if (key === 'End') next = this.view.length - 1;
      else if (key === 'ArrowRight') next = cur + 1;
      else if (key === 'ArrowLeft') next = cur - 1;
      else if (key === 'ArrowDown') next = cur < 0 ? 0 : cur + (this.mode === 'grid' ? cols : 1);
      else if (key === 'ArrowUp') next = cur - (this.mode === 'grid' ? cols : 1);
      next = Math.max(0, Math.min(this.view.length - 1, next));
      this.anchor = next;
      this.select([this.view[next].name]);
      $(`[data-name="${CSS.escape(this.view[next].name)}"]`, this.content)?.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---------------------------------------------------------------- operations

  togglePin(p) {
    this.pins = this.pins.includes(p) ? this.pins.filter((x) => x !== p) : [...this.pins, p].slice(-12);
    storage.set(`sdc.fx.pins.${this.o.stateKey}`, this.pins);
    this.renderPlaces();
    toast(this.pins.includes(p) ? `Pinned ${baseName(p)}` : `Unpinned ${baseName(p)}`, 'success');
  }

  async newFolder() {
    const name = await promptDialog({ title: 'New folder', message: `Create a folder in ${this.path}`, label: 'Name', placeholder: 'new-folder', confirmLabel: 'Create' });
    if (!name) return;
    try {
      await rpc('files.mkdir', { ...this.t, path: this.path, name });
      await this.refresh();
      this.select([name]);
      $(`[data-name="${CSS.escape(name)}"]`, this.content)?.scrollIntoView({ block: 'nearest' });
      toast(`Created ${name}`, 'success');
    } catch (err) {
      toast(err.message, true);
    }
  }

  async newFile() {
    const name = await promptDialog({ title: 'New file', message: `Create an empty file in ${this.path}`, label: 'Name', placeholder: 'notes.txt', confirmLabel: 'Create' });
    if (!name) return;
    if (name.includes('/')) return toast('Names cannot contain "/"', true);
    const full = join(this.path, name);
    try {
      await rpc('files.write', { ...this.t, path: full, content: '', create: true });
      await this.refresh();
      this.select([name]);
      const en = this.byName.get(name);
      if (en) this.preview(full, en, { edit: true });
    } catch (err) {
      toast(err.message, true);
    }
  }

  async rename(path) {
    const old = baseName(path);
    const name = await promptDialog({ title: `Rename “${old}”`, label: 'New name', value: old, confirmLabel: 'Rename' });
    if (!name || name === old) return;
    try {
      const r = await rpc('files.rename', { ...this.t, path, name });
      if (this.pv?.path === path) this.closePreview(true);
      await this.refresh();
      this.select([baseName(r.path)]);
      toast(`Renamed to ${name}`, 'success');
    } catch (err) {
      toast(err.message, true);
    }
  }

  async moveTo(paths) {
    if (!paths.length) return;
    const dest = await promptDialog({
      title: paths.length === 1 ? `Move “${baseName(paths[0])}”` : `Move ${paths.length} items`,
      message: 'Type the destination folder. Tip: you can also drag items onto a folder, a breadcrumb or a place.',
      label: 'Destination folder',
      value: parentOf(this.path),
      confirmLabel: 'Move',
    });
    if (!dest) return;
    this.move(paths, dest.startsWith('/') ? dest : join(this.path, dest), { ask: false });
  }

  async move(paths, dest, { ask = true } = {}) {
    if (ask) {
      const ok = await confirmDialog({
        tone: 'primary',
        icon: 'move',
        title: paths.length === 1 ? `Move “${baseName(paths[0])}”?` : `Move ${paths.length} items?`,
        message: `They will be moved into ${dest}.`,
        detail: listDetail(paths),
        confirmLabel: 'Move',
      });
      if (!ok) return;
    }
    try {
      await rpc('files.move', { ...this.t, paths, dest });
      toast(`Moved ${paths.length === 1 ? baseName(paths[0]) : `${paths.length} items`} to ${dest}`, 'success');
      if (this.pv && paths.includes(this.pv.path)) this.closePreview(true);
      this.refresh();
    } catch (err) {
      toast(err.message, true);
    }
  }

  /** Delete always asks, with a press-and-hold confirmation. */
  async remove(paths) {
    if (!paths.length) return;
    const entries = paths.map((p) => (parentOf(p) === this.path ? this.byName.get(baseName(p)) : null));
    const folders = entries.filter((e) => e?.isDir).length;
    const bytes = entries.reduce((s, e) => s + (e && !e.isDir ? e.size || 0 : 0), 0);
    const where = this.isHost ? 'the server' : 'the container';
    const ok = await confirmDialog({
      tone: 'danger',
      icon: 'trash',
      title: paths.length === 1 ? `Delete “${baseName(paths[0])}”?` : `Delete ${paths.length} items?`,
      message:
        `${paths.length === 1 ? 'It is' : 'They are'} permanently deleted from ${where}. ` +
        (folders ? `${folders === 1 && paths.length === 1 ? 'The folder is' : 'Folders are'} deleted with everything inside. ` : '') +
        'This cannot be undone.' +
        (bytes ? ` (${fmtBytes(bytes)} of files${folders ? ' plus folder contents' : ''})` : ''),
      detail: listDetail(paths),
      confirmLabel: paths.length === 1 ? 'Delete' : `Delete ${paths.length} items`,
    });
    if (!ok) return;
    const els = paths.map((p) => (parentOf(p) === this.path ? $(`[data-name="${CSS.escape(baseName(p))}"]`, this.content) : null)).filter(Boolean);
    els.forEach((el) => el.classList.add('removing'));
    try {
      await rpc('files.remove', { ...this.t, paths });
      toast(paths.length === 1 ? `Deleted ${baseName(paths[0])}` : `Deleted ${paths.length} items`, 'success');
      if (this.pv && paths.some((p) => this.pv.path === p || this.pv.path.startsWith(p + '/'))) this.closePreview(true);
      if (paths.includes(this.path) || paths.some((p) => this.path.startsWith(p + '/'))) return this.open(parentOf(paths[0]));
      await new Promise((r) => setTimeout(r, 180));
      this.refresh();
    } catch (err) {
      els.forEach((el) => el.classList.remove('removing'));
      toast(err.message, true);
      this.refresh();
    }
  }

  /** Downloads run in the status island, with progress (see transfers.js). */
  download(paths, isDirHint = false) {
    if (paths.length > 1) {
      return transfers.download({ what: 'file', ...this.t, paths, path: paths[0] }, { name: `${baseName(parentOf(paths[0])) || 'root'}-selection.tar` });
    }
    const p = paths[0];
    const en = parentOf(p) === this.path ? this.byName.get(baseName(p)) : null;
    const isDir = isDirHint || !!en?.isDir;
    return transfers.download({ what: 'file', ...this.t, path: p, isDir }, { name: isDir ? `${baseName(p) || 'root'}.tar` : baseName(p), size: isDir ? null : en?.size ?? null });
  }

  async measure(path) {
    toast(`Measuring ${baseName(path)}…`);
    try {
      const r = await rpc('files.du', { ...this.t, path });
      toast(`${baseName(path) || '/'}: ${fmtBytes(r.bytes)}${r.partial ? ' (some folders were unreadable)' : ''}`, r.partial ? 'warn' : 'success');
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------------------------------------------------------------- upload

  async upload(list, dir) {
    if (!list.length) return;
    // Overwrite check against the destination folder's current contents.
    let existing = this.path === dir ? new Set(this.entries.map((e) => e.name)) : null;
    if (!existing) {
      try {
        existing = new Set((await rpc('files.list', { ...this.t, path: dir })).entries.map((e) => e.name));
      } catch {
        existing = new Set();
      }
    }
    const tops = [...new Set(list.map((x) => x.rel.split('/')[0]))];
    const clash = tops.filter((n) => existing.has(n));
    if (clash.length) {
      const ok = await confirmDialog({
        tone: 'warn',
        icon: 'upload',
        title: clash.length === 1 ? `Replace “${clash[0]}”?` : `Replace ${clash.length} existing items?`,
        message: `${clash.length === 1 ? 'An item' : 'Items'} with the same name already exist${clash.length === 1 ? 's' : ''} in ${dir}. Files are overwritten; uploaded folders are merged and their files with the same names are replaced.`,
        detail: listDetail(clash),
        confirmLabel: 'Replace',
      });
      if (!ok) return;
    } else {
      // Nothing is replaced, but files are still written: confirm what goes where.
      const bytes = list.reduce((n, x) => n + (x.file.size || 0), 0);
      const ok = await confirmDialog({
        icon: 'upload',
        title: `Upload ${list.length === 1 ? `“${list[0].rel}”` : `${list.length} files`}?`,
        facts: [
          ['To', dir],
          ['On', this.isHost ? `the server${this.o.source ? ` (${this.o.source})` : ''}` : `container ${this.o.source || this.t.id}`],
          ['Size', fmtBytes(bytes)],
          tops.length > 1 || list.length > 1 ? ['Items', listDetail(tops).split('\n').slice(0, 4).join(', ')] : null,
        ],
        confirmLabel: 'Upload',
      });
      if (!ok) return;
    }
    // Progress, speed, cancel and the summary are shown in the status island.
    transfers.upload(list, {
      params: this.t,
      dir,
      onDone: ({ done }) => {
        if (done && this.root.isConnected) this.refresh();
      },
    });
  }

  // ---------------------------------------------------------------- preview / editor

  async preview(path, entry, { edit = false } = {}) {
    if (this.pv?.editing && this.pv.dirty && this.pv.path !== path) {
      if (!(await this.confirmDiscard())) return;
    }
    const box = $('.fx-preview', this.root);
    const kind = kindOf(entry || { name: baseName(path) });
    this.ed?.dispose();
    this.ed = null;
    this.pv = { path, entry, kind, text: null, editing: false, dirty: false };
    box.hidden = false;
    this.root.classList.add('has-preview');
    const head = (extra = '') => `
      <div class="fx-pv-head">
        <span class="fx-pv-ic">${entryIconHtml({ name: baseName(path), isDir: false }) || icon(KIND_ICON[kind])}</span>
        <div class="fx-pv-title"><strong class="mono" title="${esc(path)}">${esc(baseName(path))}</strong>
          <span class="muted tiny" title="${esc(path)}">${entry ? `${fmtBytes(entry.size)} · ${esc(parentOf(path))}` : esc(parentOf(path))}</span></div>
        <span class="spacer"></span>${extra}
        <button class="icon-btn" data-act="pv-dl" title="Download">${icon('download')}</button>
        <button class="icon-btn" data-act="pv-close" title="Close preview">${icon('x')}</button>
      </div>`;
    const ext = extOf(path);
    if (IMAGE_EXT.has(ext)) {
      box.innerHTML = `${head()}<div class="fx-pv-img"><div class="fx-pv-spin">${icon('refresh', 'spinning')}</div></div><div class="fx-pv-foot muted tiny"></div>`;
      try {
        const r = await rpc('files.image', { ...this.t, path, limit: 12 * 1024 * 1024 });
        if (this.pv?.path !== path) return;
        if (r.tooLarge) {
          $('.fx-pv-img', box).innerHTML = `<div class="fx-pv-msg">${icon('image', 'big')}<span>Too large to preview here (over 12 MiB). Download it instead.</span></div>`;
          return;
        }
        const img = new Image();
        img.onload = () => {
          if (this.pv?.path !== path) return;
          $('.fx-pv-img', box).innerHTML = '';
          $('.fx-pv-img', box).appendChild(img);
          $('.fx-pv-foot', box).textContent = `${img.naturalWidth} × ${img.naturalHeight} px · ${r.mime}`;
        };
        img.onerror = () => ($('.fx-pv-img', box).innerHTML = `<div class="fx-pv-msg">${icon('alert', 'big')}<span>This image could not be displayed.</span></div>`);
        img.src = `data:${r.mime};base64,${r.data}`;
      } catch (err) {
        if (this.pv?.path === path) $('.fx-pv-img', box).innerHTML = `<div class="fx-pv-msg">${icon('alert', 'big')}<span>${esc(err.message)}</span></div>`;
      }
      return;
    }
    box.innerHTML = `${head(`<span class="fx-pv-actions"></span>`)}<div class="fx-pv-text"><div class="fx-pv-spin">${icon('refresh', 'spinning')}</div></div>`;
    try {
      const r = await rpc('files.read', { ...this.t, path });
      if (this.pv?.path !== path) return;
      const wrap = $('.fx-pv-text', box);
      if (r.binary) {
        wrap.innerHTML = `<div class="fx-pv-msg">${icon(KIND_ICON[kind], 'big')}<span>Binary file. Download it to open it.</span><button class="btn small" data-act="pv-dl">${icon('download')}Download</button></div>`;
        return;
      }
      this.pv.text = r.text;
      this.pv.truncated = r.truncated;
      const lines = r.text.split('\n').length;
      wrap.innerHTML = `
        <div class="fx-code fx-monaco"><div class="fx-pv-spin">${icon('refresh', 'spinning')}</div></div>
        <div class="fx-pv-foot muted tiny"><span class="fx-pv-lang"></span><span class="fx-pv-pos"></span><span class="fx-pv-lines">${lines} line${lines === 1 ? '' : 's'}</span>${r.truncated ? '<span>preview limited to the first 1 MiB</span>' : ''}<span class="spacer"></span><span class="fx-pv-state"></span></div>`;
      const pvToken = this.pv;
      try {
        // VS Code's editor (Monaco): syntax colours by file type, minimap, find, multi-cursor…
        const ed = await createCodeEditor($('.fx-monaco', wrap), { path, text: r.text, readOnly: true });
        if (this.pv !== pvToken) return ed.dispose();
        $('.fx-monaco .fx-pv-spin', wrap)?.remove();
        this.ed = ed;
        $('.fx-pv-lang', wrap).textContent = ed.language;
        ed.onCursor((ln, col) => ($('.fx-pv-pos', wrap).textContent = `Ln ${ln}, Col ${col}`));
        ed.onChange(() => {
          if (this.pv !== pvToken) return;
          this.pv.dirty = ed.value() !== this.pv.text;
          $('.fx-pv-lines', wrap).textContent = `${ed.lineCount()} lines`;
          this.paintEditState();
        });
        ed.onSave(() => this.saveEdit());
      } catch {
        if (this.pv !== pvToken) return;
        this.mountTextarea(wrap, r); // plain editor if Monaco can't load
      }
      this.paintEditState();
      if (edit) this.startEdit();
    } catch (err) {
      if (this.pv?.path === path) $('.fx-pv-text', box).innerHTML = `<div class="fx-pv-msg">${icon('alert', 'big')}<span>${esc(err.message)}</span></div>`;
    }
  }

  /** Plain-text fallback editor (with line numbers) when the code editor isn't available. */
  mountTextarea(wrap, r) {
    const code = $('.fx-code', wrap);
    code.classList.remove('fx-monaco');
    code.innerHTML = '<pre class="fx-gutter" aria-hidden="true"></pre><textarea class="fx-editor" spellcheck="false" wrap="off" readonly></textarea>';
    const ta = $('.fx-editor', wrap);
    const gutter = $('.fx-gutter', wrap);
    ta.value = r.text;
    const paintGutter = () => {
      const n = ta.value.split('\n').length;
      if (gutter._n !== n) {
        gutter._n = n;
        gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
      }
    };
    paintGutter();
    ta.addEventListener('scroll', () => (gutter.scrollTop = ta.scrollTop));
    ta.addEventListener('input', () => {
      paintGutter();
      if (!this.pv) return;
      this.pv.dirty = ta.value !== this.pv.text;
      this.paintEditState();
    });
    ta.addEventListener('keydown', (e) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.saveEdit();
      } else if (e.key === 'Tab' && !ta.readOnly) {
        e.preventDefault();
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    });
  }

  /** Current text in the preview editor (code editor or fallback). */
  pvValue() {
    if (this.ed) return this.ed.value();
    return $('.fx-preview .fx-editor', this.root)?.value ?? null;
  }

  paintPreviewIcon() {
    const ic = $('.fx-preview .fx-pv-ic', this.root);
    if (ic && this.pv) ic.innerHTML = entryIconHtml({ name: baseName(this.pv.path), isDir: false }) || icon(KIND_ICON[this.pv.kind]);
  }

  paintEditState() {
    const pv = this.pv;
    const box = $('.fx-preview', this.root);
    const actions = $('.fx-pv-actions', box);
    if (!pv || !actions) return;
    const canEdit = pv.text !== null && !pv.truncated && (pv.entry?.size ?? 0) <= EDIT_MAX_BYTES;
    actions.innerHTML = pv.editing
      ? `<button class="btn small primary" data-act="pv-save" ${pv.dirty ? '' : 'disabled'}>${icon('save')}Save</button>`
      : `${pv.text !== null ? `<button class="icon-btn" data-act="pv-copy" title="Copy contents">${icon('copy')}</button>` : ''}${canEdit ? `<button class="btn small ghost" data-act="pv-edit">${icon('edit')}Edit</button>` : ''}`;
    const st = $('.fx-pv-state', box);
    if (st) st.innerHTML = pv.editing ? (pv.dirty ? `<span class="fx-dirty">● Unsaved changes</span> · ${isMac ? '⌘' : 'Ctrl+'}S to save` : 'Editing') : '';
    box.classList.toggle('editing', pv.editing);
  }

  startEdit() {
    if (!this.pv) return;
    if (this.ed) {
      this.pv.editing = true;
      this.ed.setReadOnly(false);
      this.ed.focus();
      return this.paintEditState();
    }
    const ta = $('.fx-preview .fx-editor', this.root);
    if (!ta) return;
    this.pv.editing = true;
    ta.readOnly = false;
    ta.focus();
    this.paintEditState();
  }

  async saveEdit() {
    const pv = this.pv;
    const value = this.pvValue();
    if (!pv || !pv.editing || value == null || !pv.dirty) return;
    // Confirm with a summary of what changed (lines added / removed).
    const { added, removed } = lineDiff(pv.text ?? '', value);
    const ok = await confirmDialog({
      icon: 'save',
      title: `Save changes to ${baseName(pv.path)}?`,
      message: 'The file on the server is overwritten with your version.',
      facts: [
        ['File', pv.path],
        ['Changes', `+${added} line${added === 1 ? '' : 's'} added, −${removed} removed`],
        ['Size', `${fmtBytes(new Blob([pv.text ?? '']).size)} → ${fmtBytes(new Blob([value]).size)}`],
      ],
      warnings: /^\/etc\/|\.(service|conf|cfg|ini|ya?ml|env)$/i.test(pv.path) ? ['This looks like a configuration file: a mistake can stop a service from starting.'] : [],
      confirmLabel: 'Save',
    });
    if (!ok) return;
    const btn = $('[data-act="pv-save"]', this.root);
    if (btn) btn.disabled = true;
    try {
      await rpc('files.write', { ...this.t, path: pv.path, content: value });
      pv.text = value;
      pv.dirty = false;
      toast(`Saved ${baseName(pv.path)}`, 'success');
      this.refresh();
    } catch (err) {
      toast(err.message, true);
    }
    this.paintEditState();
  }

  confirmDiscard() {
    return confirmDialog({
      tone: 'primary',
      icon: 'edit',
      title: 'Discard unsaved changes?',
      message: `Your changes to ${baseName(this.pv.path)} have not been saved.`,
      confirmLabel: 'Discard changes',
    });
  }

  async closePreview(force = false) {
    if (!force && this.pv?.editing && this.pv.dirty && !(await this.confirmDiscard())) return;
    this.pv = null;
    this.ed?.dispose();
    this.ed = null;
    $('.fx-preview', this.root).hidden = true;
    $('.fx-preview', this.root).innerHTML = '';
    this.root.classList.remove('has-preview');
  }

  destroy() {
    panels.delete(this);
    this.ed?.dispose();
    this.io.disconnect();
    this.root.remove();
  }
}

function treeIcon(name, open) {
  const url = folderIconUrl(name, open);
  return url ? `<img class="fi" src="${url}" alt="" draggable="false" decoding="async" />` : icon(open ? 'folderOpen' : 'folder');
}

function cmpNames(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** "/a/b/c" → ["/", "/a", "/a/b", "/a/b/c"] */
function ancestors(p) {
  const out = ['/'];
  let acc = '';
  for (const s of p.split('/').filter(Boolean)) out.push((acc += `/${s}`));
  return out;
}

/** Lines added and removed between two texts (multiset of lines: fast and good enough for a summary). */
function lineDiff(before, after) {
  const count = new Map();
  for (const l of before.split('\n')) count.set(l, (count.get(l) || 0) + 1);
  let added = 0;
  for (const l of after.split('\n')) {
    const n = count.get(l) || 0;
    if (n) count.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return { added, removed };
}

function listDetail(items) {
  const max = 12;
  const shown = items.slice(0, max).join('\n');
  return items.length > max ? `${shown}\n… and ${items.length - max} more` : shown;
}
