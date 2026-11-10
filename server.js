'use strict';

/**
 * ssh-console
 * ------------------
 * Serves the browser UI and bridges it to an SSH connection (one per browser WebSocket):
 * docker commands, live logs, interactive terminals (host / container / database),
 * database queries, file browsing and streaming downloads/uploads.
 *
 * Used two ways:
 *   - `npm start`            → a local web server (open it in your browser)
 *   - the macOS app          → desktop/main.js calls startServer() inside Electron
 */

const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Session, RPC, EVENTS } = require('./lib/session');
const { Store } = require('./lib/store');
const transfers = require('./lib/transfers');
const { AuditLog } = require('./lib/audit');
const fs = require('fs');

// Fingerprint of the server's own code. If the files on disk change after the server started
// (e.g. an update while `npm start` keeps running), the page is told the server is out of date,
// instead of new pages silently calling requests the running server doesn't know.
function codeHash() {
  const h = crypto.createHash('sha1');
  const files = [path.join(__dirname, 'server.js')];
  try {
    for (const f of fs.readdirSync(path.join(__dirname, 'lib')).sort()) if (f.endsWith('.js')) files.push(path.join(__dirname, 'lib', f));
  } catch { /* ignore */ }
  for (const f of files) {
    try {
      h.update(fs.readFileSync(f));
    } catch { /* ignore */ }
  }
  return h.digest('hex').slice(0, 12);
}
const BUILD = codeHash();
const PROTOCOL = 2; // bump when the page needs requests an older server doesn't have

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const isLoopback = (h) => LOOPBACK_NAMES.has(String(h).toLowerCase());

/** Host names this server answers to. Anything else is refused, which defeats DNS rebinding. */
function hostAllowList(bindHost) {
  const list = new Set(LOOPBACK_NAMES);
  if (bindHost && bindHost !== '0.0.0.0' && bindHost !== '::') list.add(bindHost.toLowerCase());
  for (const h of String(process.env.SDC_ALLOWED_HOSTS || '').split(',')) if (h.trim()) list.add(h.trim().toLowerCase());
  return list;
}
function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

// Content-Security-Policy: only this server's own scripts run. Inline scripts, eval, plugins,
// framing by other sites and form posts are blocked (the app frames only its own pages: one per tab), which also contains any HTML-injection bug.
// Inline styles stay allowed: the UI and the code editor set element styles at run time.
function csp(hostHeader, secure) {
  const ws = `${secure ? 'wss' : 'ws'}://${hostHeader}`;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${ws}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/**
 * opts:
 *   port, host            where to listen (default 3000 on 127.0.0.1)
 *   fallbackToRandomPort  if the port is taken, pick a free one instead of failing
 *   token                 access token every WebSocket must present as ?k=<token>. The desktop app
 *                         passes a per-launch one; otherwise a persistent one from the data folder.
 *   store                 profile store (defaults to ~/.ssh-console, without saved secrets)
 *   tls                   { cert, key } (PEM) to serve HTTPS/WSS instead of HTTP
 * Resolves to { server, port, url, token }.
 */
function startServer(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const store = opts.store || new Store();
  const token = opts.token || store.accessToken();
  const secure = Boolean(opts.tls);
  if (!secure && !isLoopback(host) && process.env.SDC_ALLOW_INSECURE_HTTP !== '1') {
    return Promise.reject(new Error(
      `Refusing to serve plain HTTP on ${host}: passwords would cross the network unencrypted. ` +
        'Set SDC_TLS_CERT and SDC_TLS_KEY to serve HTTPS (or SDC_ALLOW_INSECURE_HTTP=1 behind a TLS proxy).',
    ));
  }
  const audit = opts.audit || new AuditLog(store.dir);
  const allowedHosts = hostAllowList(host);
  const hostOk = (req) => allowedHosts.has(hostnameOf(req.headers.host));

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    if (!hostOk(req)) return res.status(421).type('text/plain').send('Unknown host name');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()');
    res.setHeader('Content-Security-Policy', csp(req.headers.host, secure));
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (['/', '/app', '/index.html', '/tabs.html'].includes(req.path) || req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // "/" is the tab bar; each tab shows the console ("/app") in a frame of its own.
  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'tabs.html')));
  app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.use(express.static(path.join(__dirname, 'public'), { index: false }));
  for (const pkg of ['xterm', 'addon-fit', 'addon-search', 'addon-web-links']) {
    app.use(`/vendor/${pkg}`, express.static(path.join(__dirname, 'node_modules/@xterm', pkg)));
  }
  // Code editor (Monaco, the editor VS Code is built on) and file icons (VS Code's Material Icon
  // Theme). Served locally, so they work offline.
  app.use('/vendor/monaco', express.static(path.join(__dirname, 'node_modules/monaco-editor/min'), { maxAge: '1d' }));
  app.use('/vendor/file-icons', express.static(path.join(__dirname, 'node_modules/material-icon-theme/icons'), { maxAge: '7d' }));
  app.get('/vendor/file-icons.json', (_req, res) =>
    res.sendFile(path.join(__dirname, 'node_modules/material-icon-theme/dist/material-icons.json'), { maxAge: '1d' }),
  );
  app.get('/api/download/:token', transfers.handleDownload);
  app.post('/api/upload/:token', transfers.handleUpload);

  const server = secure ? https.createServer({ cert: opts.tls.cert, key: opts.tls.key, minVersion: 'TLSv1.2' }, app) : http.createServer(app);
  // Uploads (files, database restores) can take longer than Node's default 5-minute limit for a
  // whole request. Header timeouts still apply, so idle half-open connections are dropped.
  server.requestTimeout = 0;
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 4 * 1024 * 1024,
    verifyClient: ({ origin, req }) => {
      // Only our own host names (DNS rebinding), only our own pages (cross-site WebSocket
      // hijacking), and only with the access token (other programs and users on this machine).
      if (!hostOk(req)) return false;
      if (origin) {
        try {
          if (new URL(origin).host !== req.headers.host) return false;
        } catch {
          return false;
        }
      }
      const k = new URL(req.url, 'http://x').searchParams.get('k') || '';
      return safeEqual(k, token);
    },
  });

  wss.on('connection', (ws) => {
    let session = new Session(ws, store);

    ws.on('message', async (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (!m || typeof m.type !== 'string') return;
      // This socket's session was taken over by a reloaded page: ignore anything it still sends,
      // so a stale page can never close the shells the new page just adopted.
      if (session.ws !== ws) return;

      // After a page reload: take over the SSH session the previous page left behind (even if
      // the server hasn't noticed the old page's socket closing yet).
      if (m.type === 'resume') {
        const resumed = !session.conn ? Session.resume(m.token, ws) : null;
        if (resumed) {
          session = resumed;
          session.send({ type: 'result', reqId: m.reqId, ok: true, data: session.resumeInfo() });
        } else {
          session.send({ type: 'result', reqId: m.reqId, ok: false, error: 'The previous session has ended' });
        }
        return;
      }

      // Handshake: which build is running, and is the code on disk still the same?
      if (m.type === 'hello') {
        const now = codeHash();
        session.send({ type: 'result', reqId: m.reqId, ok: true, data: { protocol: PROTOCOL, build: BUILD, outdated: now !== BUILD } });
        return;
      }

      // The activity log is local data: readable without an SSH connection.
      if (m.type === 'audit.list') {
        session.send({ type: 'result', reqId: m.reqId, ok: true, data: audit.tail(Math.min(Number(m.limit) || 300, 2000)) });
        return;
      }

      if (Object.hasOwn(RPC, m.type)) {
        try {
          const data = await RPC[m.type](session, m);
          session.send({ type: 'result', reqId: m.reqId, ok: true, data });
          audit.record(session, m, { ok: true, data });
        } catch (err) {
          const error = err.message || String(err);
          session.send({ type: 'result', reqId: m.reqId, ok: false, error });
          // A host-key prompt or a sudo-password prompt is a question, not a failure worth logging.
          if (!/^(HOSTKEY_UNKNOWN|SUDO_PASSWORD)\|/.test(error)) audit.record(session, m, { ok: false, error });
        }
      } else if (Object.hasOwn(EVENTS, m.type)) {
        try {
          EVENTS[m.type](session, m);
          if (audit.has(m.type)) audit.record(session, m, { ok: true });
        } catch (err) {
          if (m.type === 'term:open') session.send({ type: 'term:exit', termId: m.termId, error: err.message });
          else if (m.type === 'logs:start') session.send({ type: 'logs:end', token: m.token, error: err.message });
        }
      } else if (m.reqId != null) {
        // Never leave a request unanswered: the page would wait forever.
        session.send({ type: 'result', reqId: m.reqId, ok: false, error: `Unknown request "${String(m.type).slice(0, 60)}": the console server is out of date. Restart it.` });
      }
    });

    // Keep the SSH session for a few minutes so a reloaded page can resume it. Only the socket
    // that currently owns the session may detach it.
    const onGone = () => {
      if (session.ws === ws) session.detach();
    };
    ws.on('close', onGone);
    ws.on('error', onGone);
  });
  wss.on('error', () => { /* surfaced through the http server */ });

  return new Promise((resolve, reject) => {
    const listen = (port) => {
      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        const actual = server.address().port;
        const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
        resolve({ server, port: actual, url: `${secure ? 'https' : 'http'}://${shown}:${actual}`, token });
      });
    };
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && opts.fallbackToRandomPort) return listen(0);
      reject(err);
    };
    listen(opts.port ?? 3000);
  });
}

module.exports = { startServer };

// ---------------------------------------------------------------- CLI: `node server.js`
if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  // Bind to localhost by default: anyone who can reach this server can use it to open SSH sessions.
  const HOST = process.env.HOST || '127.0.0.1';
  let tls;
  if (process.env.SDC_TLS_CERT || process.env.SDC_TLS_KEY) {
    tls = { cert: fs.readFileSync(process.env.SDC_TLS_CERT), key: fs.readFileSync(process.env.SDC_TLS_KEY) };
  }
  startServer({ port: PORT, host: HOST, tls, token: process.env.SDC_ACCESS_TOKEN || undefined })
    .then(({ url, token }) => {
      // The access link carries the token; the page moves it out of the address bar on load.
      console.log(`ssh-console is running. Open this link (it contains your access token):\n\n  ${url}/?k=${token}\n`);
      if (!isLoopback(HOST)) console.warn('WARNING: listening on a non-local address. Anyone who can reach it and has the link can open SSH sessions.');
    })
    .catch((err) => {
      if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Try: PORT=3001 npm start`);
      else console.error(err);
      process.exit(1);
    });
}
