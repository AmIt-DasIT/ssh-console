# ssh-console

Control any server you can SSH into: Docker containers, systemd services, processes, listening ports, files, databases and real terminals. It runs as a **macOS app** or as a local web app.

*Formerly "SSH Docker Console".*

## Install the Mac app

1. Open `dist/ssh-console-<version>-arm64.dmg` (Apple Silicon).
2. Drag **ssh-console** into **Applications**, then open it from Launchpad or Spotlight. If the old **SSH Docker Console** app is still in Applications, delete it: ssh-console keeps its saved connections and passwords.

The build is ad-hoc signed, not notarized. It opens normally on the Mac that built it. Copied to another Mac, the first launch needs **right-click → Open** (or `xattr -dr com.apple.quarantine "/Applications/ssh-console.app"`). After an update, macOS may ask once whether ssh-console may use its Keychain entry; choose **Always Allow**.

To rebuild: `npm install && npm run dist:mac`. For a build that also runs on Intel Macs, use `npm run dist:mac-universal`.

**What the Mac app adds over the web version:**

- **Saved passwords and keys:** encrypted with Electron `safeStorage`, whose key lives in your macOS Keychain. They never reach the page.
- **Auto-connect:** opens straight into your saved server.
- **Session restore:** reopens the last container and tab.
- **Desktop integration:** native window and menus, multiple windows (⌘N), system notifications when a container stops or turns unhealthy, and a Dock badge counting troubled containers.
- **Host-key pinning:** if a saved server's host key changes, the connection is refused before any credentials are sent, until you accept the new key.
- **Data folder:** `~/Library/Application Support/ssh-console` (Help → Open Data Folder). Installs from before the rename keep using `~/Library/Application Support/SSH Docker Console` and its Keychain entry, so nothing is lost.

## Install on Debian / Ubuntu

Build the package with `npm run dist:deb` (x64), `npm run dist:deb-arm64` (ARM64, e.g. Raspberry Pi 4/5) or `npm run dist:deb-all` (both). Each one writes `dist/ssh-console_<version>_<arch>.deb`. Then install it with:

```sh
sudo apt install ./dist/ssh-console_<version>_amd64.deb
```

`apt` installs the libraries it needs too. The app then shows up in the application menu under **Development**, or you can start it with `ssh-console`. Saved passwords go to the desktop keyring (GNOME Keyring or KWallet) through libsecret.

To build the `.deb` on a Mac, electron-builder first downloads its own copy of `fpm`. If that step fails, run `brew install gnu-tar` and try again, or build on a Debian/Ubuntu machine instead.

The `.deb` can't update itself, because installing a package needs a password. For automatic updates, use the AppImage instead: `npm run dist:appimage` writes `dist/ssh-console-<version>-x86_64.AppImage`. Make it executable (`chmod +x`) and run it from a folder you can write to, such as `~/Applications`. Ubuntu 22.04 and later need `sudo apt install libfuse2` to run AppImages.

## Automatic updates

The Mac app and the Linux AppImage check GitHub Releases for a newer version at launch and every 4 hours. **ssh-console → Check for Updates…** checks right away. When a newer version is out, an **Update to x.y.z** button shows up in the tab bar:

1. **Update** downloads it and shows the percentage. You can cancel the download.
2. The download is checked against the SHA-256 checksum in the release, and the Mac zip's app ID, version and code signature are verified too.
3. ssh-console restarts after a 5-second countdown, which you can cancel. The countdown waits while an upload is running or a file has unsaved changes. The restart closes open SSH sessions and terminals. If you cancel, the update is applied the next time the app quits.

The app must be somewhere it can replace itself, e.g. `/Applications` or a writable folder for the AppImage. When it can't (it was started from the disk image, or it's the `.deb`), **Download** opens the release page instead.

### Publishing an update

One-time setup:

Create a **public** GitHub repository just for the builds, e.g. `your-name/ssh-console-releases`, and give it one commit (a README is enough). Your source code doesn't go there.

Put its name in `package.json` under `"updateRepo"`, then build and install the app once by hand. Copies built before this setting existed can't update themselves.

Optional, so uploads happen automatically: create a fine-grained GitHub token with **Contents: Read and write** on that repository only.

For every release:

```sh
# 1. raise "version" in package.json (e.g. 1.3.0 → 1.4.0)
# 2. build what you ship
npm run dist:mac            # Mac: .dmg + .zip (the .zip is what updates use)
npm run dist:appimage       # Linux: AppImage (updates) — add dist:deb for first installs
# 3. publish
GH_TOKEN=github_pat_… npm run release -- --notes "What changed"
```

`npm run dist:release` does all of the build steps plus the release in one go.

`npm run release` writes `dist/latest.json`, holding the version, notes, file names and SHA-256 checksums. It uploads the release as a draft, adds `latest.json` last, and only then publishes it, so a running app never sees a half-uploaded release. Without `GH_TOKEN` it uploads nothing and prints which files to attach to a new release on github.com by hand. Keep **Set as the latest release** checked.

To try a release before publishing it, serve the `dist/` folder over HTTP and start a separate copy of the app pointed at it. That copy has its own data, so your normal install isn't affected:

```sh
SSH_CONSOLE_INSTANCE=test SSH_CONSOLE_UPDATE_FEED=http://127.0.0.1:8765 /path/to/older/ssh-console.app/Contents/MacOS/ssh-console
```

## Features

**Host dashboard**, shown as soon as you connect:

- **Files (gallery):**
  - **Code editor:** files open in VS Code's editor (Monaco). It has syntax colours for the file's language (JavaScript/`.mjs`, TypeScript, JSON, YAML, Python, Dockerfile, CSS, Markdown and many more), a minimap, find and replace, multiple cursors, bracket colouring, ⌘S to save, and Dark+ or Light+ colours that follow the app's theme.
  - **Icons:** file and folder icons follow VS Code's Material Icon Theme.
  - **List columns:** Size and Modified show by default. Turn on Permissions and Owner from the columns button in the list header, or by right-clicking the header. Columns that don't fit next to a readable name hide automatically.
  - **Browsing:** browse the server's filesystem as a gallery with image thumbnails, or as a list. Use breadcrumbs, places and pins, filtering and sorting. You can multi-select with ⌘/Ctrl/Shift-click and arrow keys. Drag files or whole folders from your computer to upload them, and drag items onto a folder, breadcrumb or place to move them. There are also new folder/file, rename, an editor with save (⌘S), image preview, folder size, download (a file, a folder, or a selection as `.tar`), and "Open in terminal". Every delete, and every upload that would overwrite something, asks first with a press-and-hold confirmation.
- **Overview:** OS, kernel, uptime, load, memory and disk usage, Docker engine info, Docker disk usage, and the database containers it detected.
- **Containers:** live CPU, memory, network and block I/O for every container, with sortable columns.
- **Images:** used-by information, image removal, and pruning of dangling images.
- **Volumes and networks:** each one listed with the containers that use it.
- **Database:** a SQL console that uses the MySQL or Postgres client installed on the host, for databases that don't run in Docker.
- **Terminal:** a full interactive SSH shell, with an optional resizable file panel beside it (the **Files** button).

**Server control** (host tabs; sudo is used when you are not root):

- **Services:** every systemd service with its state and whether it starts at boot. Filter by running, failed or stopped, and start, stop, restart, reload, enable or disable a service (risky actions need a press-and-hold). Click one for its main PID, memory, CPU time and restart count, a link to its unit file, and a **live journal**.
- **Processes:** a live `top`-style list, refreshed every 3 seconds, with CPU and memory bars, sorting and search. The list holds still while the pointer is over it. End a process politely (SIGTERM) or force it (SIGKILL).
- **Ports:** everything listening on the server, whether it is reachable from outside or only locally, the process that owns it (click to see it in Processes), the container that publishes it (click to open it), and a link to open HTTP ports in the browser.
- **Commands:** run any command and watch its output stream in, with the exit code and how long it took. Save the commands you use often, for every server or just this one, and run them from here or from ⌘K. Ready-made ideas include the biggest folders, the biggest log files, failed services, memory hogs, kernel messages and pending updates.
- **sudo:** your login password is tried first. If sudo wants a different one, you are asked once, and it is kept in memory for that session only, never written to disk or put on a command line.
- **Images:** **Pull image** downloads an image and shows the pull's progress live.

**Each container** has these tabs:

- **Overview:** state and health, ports, networks, mounts, resource limits and labels.
- **Logs:** live logs in colour, with tail and since filters, search and full-log download.
- **Terminal:** an interactive shell (`docker exec -it`), using bash, ash or sh.
- **Database:** appears automatically for MySQL, MariaDB, PostgreSQL, MongoDB and Redis containers (see below).
- **Files:** the same file manager as the host's, inside the container. Places include the working directory and the container's mounts.
- **Stats:** live charts for CPU, memory, network and disk throughput, and PIDs. They fill the width from the second sample and then scroll at the real sampling rate. The axis rescales smoothly, and hovering shows exact values.
- **Processes, Environment (values masked until you reveal them), Inspect (raw JSON)**
- **Actions:** start, stop, restart, pause, resume and remove. Stop, restart, pause and remove open a confirmation where you press and hold the button to confirm, so a stray click or Enter can never trigger them.

**Compose projects:** containers are grouped by project. Groups can be collapsed, and each has *start all / restart all / stop all* actions, which also ask for confirmation.

**Uploads and downloads:**

- **Where they show:** in the status island at the top. It shows a progress ring, bytes, speed, time left and the percentage. Click it to see every file with its own progress and a cancel button. When everything is done it turns into a short summary.
- **Uploads are atomic:** data goes to a hidden temporary file and only replaces the target once every byte has arrived. A cancelled or broken upload never leaves a truncated file or damages the file it would have replaced. Overwriting keeps the file's permissions.
- **In the Mac app:** downloads are saved straight to Downloads, never overwriting an existing file, and the summary has a "Show in Finder" button.

**Productivity:**

- **Command palette (⌘K):** jump to any container, tab or action.
- **Shortcuts:** `/` filters the container list, ⌥1…9 switch a server's sections (Overview, Logs, …), ⌘B toggles the sidebar, ⌘, opens settings, ⌘K opens the command palette.
- **Appearance:** light, dark or system theme, and an adjustable terminal font size.
- **Logs:** ERROR, WARN, INFO and DEBUG lines are colour-coded.
- **Ports:** published ports are clickable links.

**Reload-safe sessions:**

- **⌘R, Ctrl+R and F5 refresh the view:** they reload the data on screen without reloading the page. A focused terminal still gets Ctrl+R and F5.
- **A real reload keeps you connected:** this covers the browser's reload button and **View → Reload Window** (⇧⌘R) in the app. The server holds the SSH session for 3 minutes after the page goes away. The reloaded page picks it up again without asking for the password, even if the old page's connection hasn't closed yet. It comes back with the same container, tab and folder, and your host and container shells with their scrollback.
- **If the session has ended:** for example, after the console server restarted. A server with a saved password reconnects on its own.
- **Unsaved work is protected:** reloading or disconnecting while uploads are running or a file has unsaved edits asks first.
- **Disconnecting** ends the session immediately. Set `SDC_RESUME_GRACE_MS` to change the grace period.

**Saved connections:** host, port, user, label and docker command are remembered. Passwords and keys are saved only in the Mac app, and only if you tick *Remember*.

## Confirmations and production servers

Nothing that changes a server happens on a single click. Every change opens a dialog that says exactly what will happen, where and as whom:

- **Click to confirm** for gentle changes (start a container or service, upload, save a file, insert rows, start a backup); **press and hold** for disruptive or destructive ones (stop, restart, remove, kill, delete, restore, DROP / TRUNCATE…).
- **SQL:** each statement is checked before it runs. Reads (SELECT, SHOW, EXPLAIN…) run straight away; anything that changes data, structure, users or settings is confirmed, with the statements listed. UPDATE and DELETE show **how many rows they will touch** (counted with the same WHERE first), and UPDATE / DELETE without WHERE, DROP and TRUNCATE are called out.
- **Commands:** read-only commands (`ls`, `cat`, `df`, `docker ps`, `systemctl status`, `journalctl`…) run straight away. Anything else, anything with sudo, redirection into a file or command substitution is confirmed, with extra warnings for `rm -r`, reboots, `kill` and disk tools.
- **Restore:** the file is read in the browser first. The dialog shows what it will create, drop and load, which existing tables it will replace, and warns when it's a dump from the other database engine.
- **Files:** saving an edit shows the lines added and removed (with a warning for configuration files); uploads show the destination, size and anything that would be replaced.
- **Production servers:** mark a server as production in **Settings** (or the ⌘K palette). It gets a red **Production** badge and a red line on its tab, and every risky confirmation asks you to type the server's name first.

## Tabs: many servers side by side

The window works like Chrome: every tab is a server (or a new-connection page), with its own SSH session, terminals, file manager and database consoles. Open as many as you like and switch between them instantly; background tabs stay connected.

- **Tab bar:** the server's colour tile, its name, and a spinner while connecting. A background tab that loses its connection gets a red dot. Hover for user@host:port.
- **Mouse:** click to switch, middle-click to close, drag to reorder, double-click the empty bar or press **+** for a new tab, **⌄** to search tabs. Right-click a tab for *New tab to the right*, *Reload*, *Duplicate* (another session to the same server), *Pin*, *Close*, *Close other tabs*, *Close tabs to the right* and *Reopen closed tab*.
- **Survives reloads:** tabs, their order, pins and recently closed tabs come back after a reload, and each tab picks its SSH session (and open terminals) back up. A closed tab can be reopened with its session for 3 minutes.
- **Shortcuts** (Chrome's), working everywhere in the window, including inside terminals and editors:

  |                       | Mac                       | Windows / Linux              |
  | --------------------- | ------------------------- | ---------------------------- |
  | New tab               | ⌘T                       | Ctrl+T                       |
  | Close tab             | ⌘W                       | Ctrl+W, Ctrl+F4              |
  | Reopen closed tab     | ⇧⌘T                     | Ctrl+Shift+T                 |
  | Next tab              | ⌃Tab, ⌥⌘→, ⇧⌘]      | Ctrl+Tab, Ctrl+PageDown      |
  | Previous tab          | ⌃⇧Tab, ⌥⌘←, ⇧⌘[    | Ctrl+Shift+Tab, Ctrl+PageUp  |
  | Tab 1–8 / last tab   | ⌘1–⌘8 / ⌘9            | Ctrl+1–8 / Ctrl+9           |
  | Move tab left / right | ⌃⇧PageUp / ⌃⇧PageDown | Ctrl+Shift+PageUp / PageDown |
  | Search tabs           | ⇧⌘A                     | Ctrl+Shift+A                 |
  | New window            | ⌘N                       | Ctrl+N                       |
  | Close window          | ⇧⌘W                     | Ctrl+Shift+W                 |

  In the Mac app these are caught before any page sees them, and are also in the **File** and **Tab** menus. In a web browser, the browser keeps ⌘T, ⌘W, ⇧⌘T, ⌘N and Ctrl+Tab for its own tabs, so ⌥T (new tab), ⌥W (close), ⌥⇧T (reopen) and ⌥PageDown / ⌥PageUp (next / previous) work there too. The browser asks before leaving the page while more than one server is connected.

## Database console

Open a database container and its **Database** tab connects for you.

- **Credentials:** read from the container's own environment, using the same variables the official and Bitnami images use. These are `MYSQL_ROOT_PASSWORD`/`MARIADB_ROOT_PASSWORD`, `MYSQL_USER`/`MYSQL_PASSWORD`, `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`, `MONGO_INITDB_ROOT_*`, and `redis-server --requirepass`. `*_FILE` Docker secrets are read too. You can type a different user or password at any time.
- **Query mode (SQL):**

  - **Schema browser:** a searchable database picker plus a table list with row estimates and sizes. Click a table to preview its rows, ⓘ for its columns and indexes, or ⤓ to back it up.
  - **Editor:** the Monaco (VS Code) editor with line numbers, SQL colours and autocomplete for keywords, functions, snippets, tables and columns (`alias.` lists that table's columns; hover a table to see them). ⌘/Ctrl+Enter runs everything or the selection, ⇧⌘/Ctrl+Enter runs only the statement under the cursor, ⇧⌥F formats, ⌘/Ctrl+S saves the query. Drag the bar under the editor to resize it.
  - **Variables:** write `{{name}}` anywhere and you're asked for the value when the query runs. Values are typed for you: `42` stays a number, `hello` becomes `'hello'` (escaped), `null`/`true` stay keywords. You can force Text, Number, List (for `IN (…)`) or Raw SQL. A preview shows the exact SQL before it runs.
  - **Results:** each column's type is detected (number, date, boolean, JSON, text) and shown with its own colour and badge. Click a header to sort (numbers sort as numbers), filter rows, click a row number for a detail view, double-click a cell to copy it. Export CSV, JSON (typed values), SQL `INSERT` statements, or copy TSV for a spreadsheet. NULL is shown distinctly from the string `'NULL'`.
  - **Saved and recent queries:** a searchable menu of saved queries and history, per engine, in your browser.
- **Backup (MySQL/MariaDB, PostgreSQL):** download a `.sql` (or `.sql.gz`) dump made by `mysqldump`/`mariadb-dump` or `pg_dump`:

  - the whole database, or chosen tables;
  - structure and data, structure only, or data only;
  - optionally only rows whose date column falls in a range (presets for today, last 7/30 days, this or last month, this or last year). Tables without that column can be included in full, as structure only, or left out. For PostgreSQL, constraints and indexes are written after the rows and sequences are set, so the file restores cleanly;
  - options: compression, DROP statements, routines and events or `CREATE DATABASE` (MySQL), owners and privileges or `INSERT` instead of `COPY` (PostgreSQL).

  The dump streams straight to your Downloads folder with progress in the status island. If the dump fails part-way, the download is cancelled and the error is shown, so a truncated file is never kept.
- **Restore:** drop a `.sql` or `.sql.gz` file and choose the database. Options: stop at the first error, and for PostgreSQL run it as one all-or-nothing transaction. It needs a press-and-hold to start.
- **Insights:** server version, uptime, connections, queries per second or transactions, slow queries, cache hit ratio and database size; tables ranked by size; and the queries running right now, live, with Cancel and End connection.
- **Shell mode:** an interactive `mysql`, `psql`, `mongosh` or `redis-cli` session, for transactions, `\d` commands and so on.
- **Where it runs:** the database's own client, inside the container. It needs nothing on the host and connects over the container's local socket. Use **TCP…** to set a host and port instead.

Passwords never appear on a command line, so they can't be seen in `ps`. The wrapper reads the password from stdin and hands it to the client through `MYSQL_PWD`, `PGPASSWORD` or `REDISCLI_AUTH`. Auto-detected passwords stay on the server and are never sent to the browser.

Each query in Query mode runs as a separate client session. Use Shell mode for anything that needs a session, such as `BEGIN … COMMIT` or `SET` variables.

## Run it as a web app

Requires Node.js 18 or later on the machine that runs the console. The remote server only needs `sshd` and Docker.

```bash
npm install
npm start
```

It prints an **access link** (`http://127.0.0.1:3000/?k=…`). Open that link: the page refuses to connect without it. The link stays valid across restarts. Delete `~/.ssh-console/access-token` to revoke it and get a new one.

| Variable                                      | Effect                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `PORT=8080`                                 | Listen on another port                                                                     |
| `SDC_TLS_CERT=cert.pem SDC_TLS_KEY=key.pem` | Serve HTTPS (TLS 1.2+, HSTS)                                                               |
| `HOST=0.0.0.0`                              | Listen on the network. Requires HTTPS, or `SDC_ALLOW_INSECURE_HTTP=1` behind a TLS proxy |
| `SDC_ALLOWED_HOSTS=console.example.com`     | Extra host names to answer to (everything else is refused)                                 |
| `SDC_ACCESS_TOKEN=…`                       | Use your own access token                                                                  |
| `SDC_DATA_DIR=/path`                        | Where saved connections, the token and the activity log are kept                           |

On the remote server, the SSH user must be able to run `docker`, which normally means being in the `docker` group. Otherwise, set **Advanced → Docker command** to `sudo -n docker`, which needs passwordless sudo.

## How it works

```
Browser (xterm.js) ─WebSocket─► Node (server.js, lib/) ─SSH (ssh2)─► server ─► docker CLI / DB clients
                   ─HTTP──────► one-time download/upload tokens ──────┘
```

| File                                                                  | Purpose                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.js`                                                         | HTTP + WebSocket server and routing                                                                                                                                                                                                                                                                                                                  |
| `lib/session.js`                                                    | One SSH connection per browser tab, plus containers, logs and terminals                                                                                                                                                                                                                                                                              |
| `lib/db.js`                                                         | DB engine detection, credentials and client command building                                                                                                                                                                                                                                                                                         |
| `lib/dbbackup.js`                                                   | Database backups (mysqldump / pg_dump, chosen tables, date ranges) and restores                                                                                                                                                                                                                                                                      |
| `lib/host.js`                                                       | Host and Docker system information, images, volumes, networks                                                                                                                                                                                                                                                                                        |
| `lib/knownhosts.js`                                                 | Host-key lookup in OpenSSH `known_hosts` files (hashed names, ports, wildcards, `@revoked`)                                                                                                                                                                                                                                                      |
| `lib/audit.js`                                                      | Activity log: what was done, where, and whether it worked (never secrets)                                                                                                                                                                                                                                                                            |
| `lib/system.js`                                                     | Server control: systemd services and journal, processes, listening ports, sudo, streamed command runs                                                                                                                                                                                                                                                |
| `lib/files.js`                                                      | File manager on the host or in a container: list, preview, images, edit, mkdir, rename, move, delete, size, download, upload                                                                                                                                                                                                                         |
| `lib/transfers.js`                                                  | One-time, 2-minute tokens for streaming downloads and uploads                                                                                                                                                                                                                                                                                        |
| `lib/store.js`                                                      | Saved connection profiles (secrets encrypted when running as the Mac app)                                                                                                                                                                                                                                                                            |
| `desktop/main.js`, `desktop/preload.js`                           | Electron shell for the macOS app                                                                                                                                                                                                                                                                                                                     |
| `public/tabs.html`, `public/js/tabs.js`, `public/js/tabkeys.js` | The Chrome-style tab bar (at `/`) and its shortcuts; each tab shows the console (`/app`) in a frame                                                                                                                                                                                                                                              |
| `public/js/*`                                                       | UI (ES modules): core, ui (dialogs and palette), island (status island), transfers (uploads/downloads), icons, charts (live charts, skeletons), connect, host, system (services, processes, ports, commands), containers, database, sqlkit (SQL tokenizer, formatter, variables, autocomplete), searchselect (searchable dropdowns), files, terminal |

## Security

Full details for security reviewers are in [SECURITY.md](SECURITY.md). In short:

- **SSH:** modern algorithms only by default (no SHA-1, CBC or DSA). Host keys are checked against pinned keys and your OpenSSH `known_hosts` before any credential is sent. New servers need you to confirm their fingerprint, and changed or revoked keys are refused.
- **Credentials:** passwords never appear on a command line or in a log. In the Mac app, saved secrets are encrypted with a key held in the macOS Keychain. They are kept in memory only for the session, and the password is never typed into a one-time-code prompt.
- **Local server:** listens on loopback and needs an access token on every connection. It refuses foreign host names (DNS rebinding) and other websites, and sends a strict Content-Security-Policy and other security headers. It won't serve plain HTTP on a network address.
- **Desktop app:** sandboxed renderers, IPC only from the app's own page, all web permissions denied, no developer tools in release builds, and hardened Electron fuses.
- **Accountability:** a local activity log (Settings → Activity log), plus disconnect after inactivity (1 hour by default).

## Design

Icons are [Lucide](https://lucide.dev) (ISC License). Their SVG paths are inlined in `public/js/icons.js`, so no icon font or network is needed. File-type icons in the file manager come from VS Code's Material Icon Theme.

File and folder icons come from VS Code's [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT, the `material-icon-theme` package). They are resolved the way VS Code does it: exact file name first, then the longest extension, then folder names with open and closed variants, plus the theme's light-mode variants. The code editor is [Monaco](https://github.com/microsoft/monaco-editor) (MIT), the editor VS Code is built on. Both are served locally from `node_modules`, so they work offline.

The interface follows the design language of [Kokonut UI](https://kokonutui.com) (MIT): a monochrome zinc palette, pill tab bars with a sliding thumb, hold-to-confirm buttons, a status island for notifications, an uptime-style fleet strip and metric cards. The components are re-implemented in plain JavaScript and CSS, because this app does not use React.
