'use strict';

/**
 * One-time, short-lived tokens that let plain HTTP requests (file downloads / uploads) run a
 * command on an existing SSH session. Tokens are random, single use and expire after 2 minutes.
 */

const crypto = require('crypto');

const TTL = 2 * 60 * 1000;
const transfers = new Map();

function create(session, spec) {
  const token = crypto.randomBytes(24).toString('hex');
  transfers.set(token, { ...spec, session, expires: Date.now() + TTL });
  return token;
}

function take(token, kind) {
  const t = transfers.get(token);
  transfers.delete(token);
  if (!t || t.kind !== kind || t.expires < Date.now() || !t.session.conn) return null;
  return t;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, t] of transfers) if (t.expires < now) transfers.delete(k);
}, 30000).unref();

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * GET /api/download/:token: stream the command's stdout to the browser.
 * spec.stdin (optional) is written to the command first (a database password line).
 * If the command fails after data has started flowing, the response is aborted rather than ended,
 * so the browser / app reports a failed download instead of saving a truncated file, and the page
 * is told why.
 */
function handleDownload(req, res) {
  const t = take(req.params.token, 'download');
  if (!t) return res.status(410).type('text').send('This download link has expired. Try again from the console.');
  t.session.conn.exec(t.cmd, (err, stream) => {
    if (err) return res.status(500).type('text').send(err.message);
    let started = false;
    let stderr = '';
    let clientGone = false;
    stream.stderr.on('data', (d) => {
      if (stderr.length < 64 * 1024) stderr += d;
    });
    stream.on('data', (d) => {
      if (!started) {
        started = true;
        res.setHeader('Content-Type', t.type || 'application/octet-stream');
        res.setHeader('Content-Disposition', contentDisposition(t.filename));
        res.setHeader('Cache-Control', 'no-store');
      }
      if (!res.write(d)) {
        stream.pause();
        res.once('drain', () => stream.resume());
      }
    });
    stream.on('close', (code) => {
      if (clientGone) return;
      if (!started) {
        if (code === 0) {
          res.setHeader('Content-Disposition', contentDisposition(t.filename));
          return res.status(200).end();
        }
        return res.status(500).type('text').send(stderr.trim() || `Download failed (exit ${code})`);
      }
      if (code === 0 || !t.strict) return res.end();
      t.session.send({ type: 'transfer:error', name: t.filename, error: (stderr.trim() || `exit ${code}`).slice(-2000) });
      res.destroy();
    });
    if (t.stdin != null) stream.end(t.stdin);
    req.on('close', () => {
      if (!res.writableFinished) {
        clientGone = true;
        stream.close();
      }
    });
  });
}

/** POST /api/upload/:token: pipe the request body into the command's stdin. */
function handleUpload(req, res) {
  const t = take(req.params.token, 'upload');
  if (!t) return res.status(410).json({ ok: false, error: 'Upload link expired. Try again.' });
  const len = req.headers['content-length'] != null ? Number(req.headers['content-length']) : NaN;
  const cmd = typeof t.cmd === 'function' ? t.cmd(len) : t.cmd;
  const conn = t.session.conn;
  conn.exec(cmd, (err, stream) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    let stderr = '';
    let aborted = false;
    stream.stderr.on('data', (d) => {
      if (stderr.length < 256 * 1024) stderr += d;
    });
    stream.on('data', () => {});
    stream.on('close', (code) => {
      // Belt and braces: the script already removes its temporary file when bytes are missing.
      if ((aborted || code !== 0) && t.cleanup && t.session.conn) t.session.conn.exec(t.cleanup, (e, s) => !e && s.on('data', () => {}).resume());
      if (aborted) return;
      if (code === 0) res.json({ ok: true, target: t.target });
      else res.status(500).json({ ok: false, error: stderr.trim().slice(-4000) || `Upload failed (exit ${code})` });
    });
    if (t.stdinPrefix) stream.write(t.stdinPrefix);
    req.pipe(stream);
    const abort = () => {
      if (aborted || req.complete) return;
      aborted = true;
      stream.end();
    };
    req.on('aborted', abort);
    req.on('close', abort);
  });
}

module.exports = { create, handleDownload, handleUpload };
