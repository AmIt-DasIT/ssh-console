#!/usr/bin/env node
'use strict';

/**
 * Publishes the built installers as a GitHub release, which the desktop app updates from.
 *
 *   npm run release                          # writes dist/latest.json; uploads when GH_TOKEN is set
 *   npm run release -- --notes "What changed"
 *   npm run release -- --notes-file CHANGES.md
 *   npm run release -- --draft               # upload, but leave the release as a draft (apps don't see it)
 *
 * GH_TOKEN: a GitHub token that may write to the releases repo ("updateRepo" in package.json):
 * a fine-grained token with "Contents: Read and write" on that one repo.
 *
 * Build first (npm run dist:mac, npm run dist:appimage, …). Only the files of the version in
 * package.json are picked up. The release is created as a draft, every file is uploaded with
 * latest.json last, and only then is it published, so an app never sees a half-uploaded release.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const repo = String(pkg.updateRepo || '');
const product = pkg.build?.productName || pkg.productName || pkg.name;
const distDir = path.join(root, pkg.build?.directories?.output || 'dist');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const v = escRe(version);
const p = escRe(product);
// Files the app can install itself → manifest key.
const UPDATABLE = [
  [new RegExp(`^${p}-${v}-(arm64|x64|universal)-mac\\.zip$`), (m) => `darwin-${m[1]}`],
  [new RegExp(`^${p}-${v}-(x86_64|arm64|aarch64)\\.AppImage$`), (m) => `linux-${m[1] === 'x86_64' ? 'x64' : 'arm64'}`],
];
// Installers for first installs, attached to the release too.
const EXTRA = [
  new RegExp(`^${p}-${v}(-(arm64|x64|universal))?\\.dmg$`),
  new RegExp(`^${escRe(pkg.name)}_${v}_(amd64|arm64)\\.deb$`),
];

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

async function gh(method, url, body, headers = {}) {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ssh-console-release',
      ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  return { status: res.status, ok: res.ok, data };
}

async function main() {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || /YOUR-/i.test(repo)) {
    die('Set "updateRepo" in package.json to the GitHub repository for releases, e.g. "your-name/ssh-console-releases".');
  }
  if (!fs.existsSync(distDir)) die(`No ${path.relative(root, distDir)} folder. Build first (npm run dist:mac, npm run dist:appimage, …).`);

  const names = fs.readdirSync(distDir);
  const files = {};
  const uploads = [];
  for (const name of names) {
    for (const [re, key] of UPDATABLE) {
      const m = re.exec(name);
      if (m) {
        const full = path.join(distDir, name);
        files[key(m)] = { name, size: fs.statSync(full).size, sha256: await sha256(full) };
        uploads.push(full);
      }
    }
    if (EXTRA.some((re) => re.test(name))) uploads.push(path.join(distDir, name));
  }
  if (!Object.keys(files).length) {
    die(`No updatable build of ${version} in ${path.relative(root, distDir)}/ (expected ${product}-${version}-arm64-mac.zip and/or ${product}-${version}-x86_64.AppImage). Build first.`);
  }

  const notesFile = value('--notes-file');
  const notes = notesFile ? fs.readFileSync(path.resolve(notesFile), 'utf8').trim() : (value('--notes') || '').trim();
  const manifest = { version, date: new Date().toISOString(), notes, files };
  const manifestPath = path.join(distDir, 'latest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`\nssh-console ${version} → ${repo}\n`);
  for (const [key, f] of Object.entries(files)) console.log(`  ${key.padEnd(17)} ${f.name}  (${mb(f.size)})`);
  for (const u of uploads) if (!Object.values(files).some((f) => f.name === path.basename(u))) console.log(`  ${'installer'.padEnd(17)} ${path.basename(u)}`);
  console.log(`  ${'manifest'.padEnd(17)} latest.json`);

  if (!process.env.GH_TOKEN) {
    console.log(`
No GH_TOKEN set, so nothing was uploaded. To publish by hand:
  1. Open https://github.com/${repo}/releases/new
  2. Tag: v${version}   Title: ssh-console ${version}
  3. Attach every file listed above from ${path.relative(root, distDir)}/ (latest.json included)
  4. Leave "Set as the latest release" checked and publish.
Running apps see the update within a few hours, or right away from "Check for Updates…".
`);
    return;
  }

  const tag = `v${version}`;
  let rel = await gh('GET', `/repos/${repo}/releases/tags/${tag}`);
  if (rel.status === 404) {
    // Drafts aren't found by tag: look for one before creating another.
    const list = await gh('GET', `/repos/${repo}/releases?per_page=30`);
    const draft = Array.isArray(list.data) && list.data.find((r) => r.draft && r.tag_name === tag);
    rel = draft ? { ok: true, data: draft } : await gh('POST', `/repos/${repo}/releases`, { tag_name: tag, name: `ssh-console ${version}`, body: notes, draft: true });
    if (!rel.ok) {
      die(`Couldn't create release ${tag}: ${rel.data?.message || rel.status}${rel.status === 422 ? ' (the repository needs at least one commit, e.g. a README)' : ''}`);
    }
  } else if (!rel.ok) {
    die(`GitHub answered ${rel.status}: ${rel.data?.message || ''} (check GH_TOKEN and updateRepo)`);
  }
  const release = rel.data;

  // latest.json goes last: the update only becomes visible once everything it points to is there.
  for (const file of [...uploads, manifestPath]) {
    const name = path.basename(file);
    const old = (release.assets || []).find((a) => a.name === name);
    if (old) await gh('DELETE', `/repos/${repo}/releases/assets/${old.id}`);
    process.stdout.write(`  uploading ${name}… `);
    const up = await gh('POST', `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, fs.readFileSync(file), { 'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    if (!up.ok) die(`upload of ${name} failed: ${up.data?.message || up.status}`);
    console.log('done');
  }

  if (flag('--draft')) {
    console.log(`\nUploaded as a draft: ${release.html_url}\nPublish it on GitHub when ready; apps don't see drafts.\n`);
    return;
  }
  const pub = await gh('PATCH', `/repos/${repo}/releases/${release.id}`, { draft: false, make_latest: 'true', body: notes || release.body || '' });
  if (!pub.ok) die(`Couldn't publish the release: ${pub.data?.message || pub.status}`);
  console.log(`\n✓ Published ${pub.data.html_url}\nRunning apps see the update within a few hours, or right away from "Check for Updates…".\n`);
}

main().catch((err) => die(err.stack || err.message));
