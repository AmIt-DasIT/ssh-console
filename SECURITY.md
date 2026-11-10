# ssh-console security

This document describes how ssh-console protects the servers it manages, the credentials it handles, and the machine it runs on. It is written for security and IT teams evaluating the application.

ssh-console runs on an operator's own computer, either as a macOS desktop app or as a local web app. It connects to servers over SSH and does nothing else on the network. There is no cloud service, no telemetry and no account: nothing is sent anywhere except to the servers the operator connects to.

## Architecture and trust boundaries

```
Operator's computer                                              Managed server
┌───────────────────────────────────────────────┐
│  UI (Electron window or browser tab)          │
│      │  WebSocket on 127.0.0.1, access token  │
│  Local server (Node.js)  ─────────────────────┼── SSH ──►  sshd → docker, systemctl, …
│      │                                        │
│  Data folder (0700): profiles, audit log      │
│  macOS Keychain: key that encrypts secrets    │
└───────────────────────────────────────────────┘
```

| Boundary | What protects it |
| --- | --- |
| Network, between the operator's computer and the managed server | SSH with modern algorithms only, host-key verification before any credential is sent |
| Other programs and users on the operator's computer, and malicious websites | Server bound to loopback, an access token on every WebSocket, a Host-header allowlist, origin checks |
| The UI itself (HTML injection, malicious content shown from a server) | Strict Content-Security-Policy, output escaping, sandboxed renderer |
| Stored data | Owner-only file permissions; secrets encrypted with a Keychain-held key |

## SSH transport

- **Library:** [ssh2](https://github.com/mscdex/ssh2), a pure-JavaScript SSH2 implementation using Node.js/OpenSSL cryptography.
- **Modern algorithms only by default**, in line with current OpenSSH defaults and Mozilla's OpenSSH guidelines:

  | Type | Allowed |
  | --- | --- |
  | Key exchange | curve25519-sha256, ECDH (P-256/384/521), DH group-exchange SHA-256, DH groups 14/16/18 with SHA-2 |
  | Ciphers | AES-256-GCM, AES-128-GCM, AES-CTR, plus chacha20-poly1305 in the web version (the Mac app's crypto library, BoringSSL, does not provide it) |
  | MACs | HMAC-SHA2-256/512 (encrypt-then-MAC preferred) |
  | Host keys | Ed25519, ECDSA, RSA with SHA-2 signatures |
  | Compression | none |

  SHA-1 key exchange, SHA-1 MACs, `ssh-rsa` (SHA-1) signatures, CBC ciphers, 3DES, MD5 and DSA are refused. A server that only offers them can be enabled one connection at a time with **Advanced → Allow legacy algorithms**. That choice is saved with the connection, shown in the host overview, and recorded in the activity log.
- **Not used:** agent forwarding, X11 forwarding and port forwarding. The console never exposes the operator's SSH agent or local ports to a managed server.
- **Keep-alives:** sent every 15 seconds; a dead connection is closed after 4 missed replies.

## Host-key verification

The server's host key is checked **before any password or key is sent**:

1. **Pinned key:** a key saved for this host and port must match exactly.
2. **OpenSSH `known_hosts`:** `~/.ssh/known_hosts`, `~/.ssh/known_hosts2` and `/etc/ssh/ssh_known_hosts` are honoured, including hashed host names, `[host]:port`, wildcards, negation and `@revoked`. A match is trusted. A different key of the same type is refused, as it is in OpenSSH.
3. **Unknown server:** the connection stops and the operator is shown the key type and SHA-256 fingerprint, with instructions for checking it on the server. The fingerprint is trusted only after explicit confirmation, and then pinned.
4. **Changed key:** the connection is refused and a warning shows the expected and presented fingerprints. Accepting the new key needs a press-and-hold confirmation. It then re-pins every saved connection to that host and port, so the old key can't be replayed through another saved user.
5. **Revoked key:** always refused.

The page can only accept a key by sending back the exact fingerprint the server presented. A forged or stale value has no effect. Accepted keys (and how they were trusted) and refused connections are recorded in the activity log.

## Authentication and secrets

- **Methods:** password, private key (OpenSSH, PEM or PPK, optionally passphrase-protected), and keyboard-interactive **password** prompts.
- **Keyboard-interactive prompts:** the password is only ever typed into prompts that ask for a password. Any other prompt, such as a one-time code, is left unanswered and the operator is told why, so a password can never be entered into an OTP or unexpected prompt.
- **In memory:** credentials are kept only for the session, so it can reconnect and use sudo. They are wiped when the session ends, including after an idle timeout or 3 minutes after the page goes away.
- **Saved secrets (desktop app only, opt-in with "Remember"):** encrypted with Electron `safeStorage`, whose key is held in the macOS Keychain. Secrets never leave the local server process: the UI only learns whether one is saved. The web version never stores secrets.
- **sudo:** the login password is tried first. If sudo needs another password, the operator is asked once and it is kept in memory for that session only. sudo passwords are written to sudo's standard input and never appear on a command line, in `ps`, in shell history or in the activity log. A sudo prompt during a streamed command is answered at most once, so a wrong password cannot trigger repeated failed attempts.
- **Database passwords:** passed to clients through environment variables (`MYSQL_PWD`, `PGPASSWORD`, `REDISCLI_AUTH`) read from standard input, never on the command line. Credentials auto-detected from a container stay in the local server and are never sent to the UI.
- **Database backups and restores:** `mysqldump`/`pg_dump` and `mysql`/`psql` get the password the same way. Every table, column and database name is validated and quoted, and date filters only accept strict date formats. A restore runs the file's SQL as the chosen database user and needs a press-and-hold confirmation. A dump that fails part-way is aborted, so no truncated backup is saved as if it were complete. The local server holds the password for a backup or restore only until the transfer's single-use token is used or expires (2 minutes).

## The local server

The UI talks to a local Node.js server, which holds the SSH connections.

- **Loopback only.** It listens on `127.0.0.1` by default. It refuses to serve plain HTTP on any other address unless HTTPS is configured (`SDC_TLS_CERT` and `SDC_TLS_KEY`); TLS 1.2 is the minimum and HSTS is sent. `SDC_ALLOW_INSECURE_HTTP=1` overrides this, for use behind a TLS-terminating proxy only.
- **Access token.** Every WebSocket must present a random 256-bit token.
  - **Desktop app:** a new token is generated at each launch and never leaves the app.
  - **Web version:** the token is stored in the data folder (`access-token`, mode 0600) and printed once as part of the access link. The page moves it from the address bar into the tab's session storage, so it doesn't remain in history or bookmarks. Delete the file to revoke all links.
- **DNS-rebinding protection:** requests whose `Host` header is not a known name of this server are refused (HTTP 421). Allow extra names with `SDC_ALLOWED_HOSTS`.
- **Cross-site WebSocket hijacking:** connections opened by other websites (a foreign `Origin`) are refused.
- **Transfer tokens:** downloads and uploads use random, single-use tokens that expire after 2 minutes. Uploads are atomic: a cancelled upload never leaves a truncated file.
- **Input validation:** container IDs, image references, service names, process IDs, signals and database parameters are checked against strict allowlists, and paths and other values are single-quoted before they reach a remote shell.

## The user interface

- **Content-Security-Policy:**
  - only the app's own scripts may run;
  - no inline scripts, `eval`, plugins or form posts, and no frames except the app's own pages (each tab is one);
  - connections only to the app's own server.

  This also contains any HTML-injection bug.
- **Other headers:** `X-Frame-Options: SAMEORIGIN` and `frame-ancestors 'self'` (only the app's own tab bar may frame its pages; no other site can), `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and `Cache-Control: no-store` on pages and API responses.
- **Tabs:** each tab runs in its own frame with its own WebSocket, SSH session and credentials. Tabs talk to the tab bar only through `postMessage` checked against the app's own origin, and only to report a title or status or ask for a tab command. A closed tab's SSH session ends after the same 3-minute grace period as a closed page, which is what lets *Reopen closed tab* pick it back up.
- **Output escaping:** everything that comes from a server (container names, file names, logs, process lists) is HTML-escaped. Terminal and log output is rendered by xterm.js as text.

## Desktop app (Electron)

- **Renderers:** sandboxed (`app.enableSandbox()`), with context isolation and no Node.js. The preload exposes only a small allowlist of messages to the main process, and the main process ignores IPC from any page other than the app's own.
- **Navigation:** no webviews, no pop-up windows and no navigation away from the app. Web links open in the default browser.
- **Permissions:** all web permissions (camera, microphone, location, USB and others) are denied, except clipboard writing and fullscreen.
- **Developer tools:** turned off in release builds.
- **Electron fuses** (set at build time):
  - Node.js mode (`ELECTRON_RUN_AS_NODE`), `NODE_OPTIONS` and `--inspect` flags are disabled;
  - the app only loads from its own archive, and that archive's integrity is checked at startup;
  - cookies are encrypted.

## Activity log

Security-relevant actions are appended to `audit.log` in the data folder (mode 0600, rotated at 5 MB). Each entry records the time, the local OS user, the SSH target, the action and whether it worked. Logged actions:

- connections, including host-key trust decisions and failures;
- disconnects;
- container, service and process actions;
- file changes, uploads and downloads;
- commands run, including image pulls;
- database query types, backups (database, table count, content, date range) and restores (database, file name);
- terminal sessions;
- sudo use;
- changes to saved connections.

The log never contains passwords, keys, passphrases, file contents, SQL text or environment values. Operators can view, filter and export it from **Settings → Activity log**.

## Session controls

- **Idle disconnect:** the SSH session ends after a period without keyboard or mouse activity. The default is 1 hour; it can be set to 15 minutes, 30 minutes, 4 hours or never. A warning is shown one minute before. Running uploads and unsaved edits postpone the disconnect and say so.
- **Confirmations:** every action that changes a server is confirmed in a dialog that states what, where and as which user. Destructive ones (remove, stop, kill, delete, disable, restore, DROP / TRUNCATE, UPDATE or DELETE without WHERE, commands that aren't read-only, accepting a changed host key) need a press-and-hold, so a stray click or keypress can't trigger them. SQL UPDATE / DELETE statements show how many rows they would affect before they run. Restore files are inspected in the browser first, and a dump from the wrong engine is flagged.
- **Production servers:** a server can be marked as production; its risky confirmations then also require typing the server's name.

## Data stored on the operator's computer

| Item | Location | Protection |
| --- | --- | --- |
| Saved connections (host, port, user, label, pinned host key, options) | `profiles.json` in the data folder | Folder 0700, file 0600 |
| Saved passwords and keys (desktop, opt-in) | Inside `profiles.json` | Encrypted with a key held in the macOS Keychain |
| Access token (web version) | `access-token` | 0600 |
| Activity log | `audit.log`, `audit.log.1` | 0600 |
| UI preferences, saved commands, query history | Browser/app local storage | Per-origin storage on the operator's account |

The data folder is `~/Library/Application Support/ssh-console` for the Mac app and `~/.ssh-console` for the web version. Permissions are tightened automatically at startup.

## Known limitations and residual risks

- **Bundled DOMPurify:** the code editor (Monaco 0.57.0) bundles DOMPurify 3.4.15, which has published advisories. Those are bypasses in DOMPurify modes Monaco does not use, and their effect (running injected script) is blocked by the Content-Security-Policy. Monaco will be updated once a stable release ships a fixed DOMPurify (3.4.17 or later).
- **Not supported:** SSH certificates (`@cert-authority`), SSH agent authentication and interactive second factors (TOTP prompts). Hosts that require them can't be used yet. Nothing is weakened to work around this.
- **Signing:** macOS builds are ad-hoc signed, not notarized. For distribution to clients, sign with a Developer ID certificate and notarize with Apple.
- **Activity log:** stored locally and protected by file permissions. It is not tamper-evident against the operator's own account. Forward it to a central log system if that is required.
- **Local traffic:** the connection between the UI and the local server is plain loopback traffic on the same machine, unless HTTPS is configured. It never crosses the network.
- **Root on the operator's computer:** an attacker with the operator's OS account, or root, can read anything the operator can. That includes unlocked Keychain items and process memory. This is outside what any desktop SSH client can defend against.
- **Server-side permissions:** what ssh-console can change on a server is exactly what the SSH user, and sudo for that user, allows. Use least-privilege accounts and sudo rules on production servers.

## Recommended deployment

1. Use the macOS app, signed and notarized for your organisation. Use the web version only on a trusted workstation.
2. Use SSH keys rather than passwords. Check new host fingerprints, or distribute a managed `known_hosts`.
3. Keep "Allow legacy algorithms" off. Upgrade servers that need it.
4. Give operators SSH accounts with only the rights they need, and scoped sudo rules rather than full root.
5. Keep the idle disconnect on, and collect `audit.log` centrally if your policy requires it.
6. Run `npm audit --omit=dev` before each release and keep Electron up to date.

## Reporting a vulnerability

Report suspected vulnerabilities privately to the maintainer at **[security contact to be added]**. Please include steps to reproduce. Do not open public issues for security problems.
