# Specifications: Persian clinic records app

Version 0.1.0. Written 2026-10-17 from `docs/SETUP.md`, `docs/TROUBLESHOOTING.md`, the Docker files and the source tree.

This document explains what the product is, how its code and system work (front end, back end, data, security), how it behaves on a server, and how to install it on a fresh Linux server step by step. Where the older guides (`docs/SETUP.md`, `docs/TROUBLESHOOTING.md`) already give a procedure, this document repeats it in a more professional and complete form and adds hardening steps that the short guide leaves out.

---

## 1. Product overview

A web application for **one private clinic with fewer than 20 staff**. It stores real patient records and their files (consents, lab results, imaging, surgery documents, photos). It is served to the internet from a **single Linux server**, and it is designed to run with almost no supervision.

| Aspect | Value |
|---|---|
| Users | Clinic staff only. No public sign-up and no patient portal |
| Language | Persian (`<html lang="fa" dir="rtl">`), all UI text in Persian |
| Calendar | Jalali on screen, Gregorian ISO (`YYYY-MM-DD`) in the database |
| Roles | `admin` and `staff` |
| Priorities, in order | 1) safe on the internet, 2) runs itself, 3) simple to install and repair |
| Out of scope | Financial tab, visit timeline, appointments, MFA, e-mail/SMS, nested search groups, multi-clinic, encryption of the database at rest |

### 1.1 Features

- **Patients:** list with search, status and sex filters, sorting and pagination (25 per page). Create, edit, archive (staff) and delete (admin only). The profile has two tabs, personal and medical, and below them a "medical documents" gallery: two large tiles per row (one on phones), images shown as previews, PDF and DICOM as file tiles. A patient photo, visit reason and referral fields (remembered values offered in a `<datalist>`) are supported.
- **Patient code:** generated automatically as `P-000123`, immutable, never reused, and used as the patient's folder name.
- **Documents:** upload PDF, JPG, PNG or DICOM (`.dcm`), at most 30 MB each, through a drag-and-drop box. The browser shrinks JPG and PNG photos over 3 MB to a JPEG of at most 3 MB before upload; the server never decodes images. Categories: consent, lab, imaging, surgery, other. Download through an authenticated route only. Staff and admins can delete a document; the file is moved to `data/trash/<code>/`, never destroyed, and the delete is audited.
- **Phones:** under 900 px the sidebar becomes a bottom tab bar (home, patients, new patient, search, and a "more" menu with the other pages and sign-out).
- **Advanced search:** up to 6 rule rows with an AND/OR switch over a fixed whitelist of fields. Saved searches (staff see their own, admins see all). Export of results as CSV or Excel.
- **Data management (admin):** CSV import with template, preview and confirm; export of all patients as CSV or right-to-left `.xlsx`; one **full zip** (database snapshot, `patients.csv`, every patient folder with its own `info.csv`, and a `README.txt`).
- **Administration:** user management (create, reset password, deactivate, delete; a deleted account can never sign in again but still appears by name in the audit log), paginated audit log with filters, own-password change.
- **Usability:** show/hide password, Jalali calendar picker on every date field, light/dark theme button, self-hosted fonts.

### 1.2 Roles

| Action | staff | admin |
|---|---|---|
| View, add, edit patients and documents | yes | yes |
| Archive and unarchive a patient | yes | yes |
| Delete a patient | no | yes |
| Manage users, import data, full zip, audit log | no | yes |

---

## 2. System architecture

```
Browser ──HTTPS (80/443)──> Caddy ──HTTP, internal Docker network──> app (Node.js, port 3000)
                            │                                         │
                            │ automatic Let's Encrypt                 ├── data/clinic.db           SQLite, WAL mode
                            │ HSTS, gzip/zstd, 35 MB body limit       ├── data/patients/P-xxxxxx/  patient files
                                                                      ├── data/backups/            nightly, newest 14 kept
                                                                      ├── data/trash/              deleted patients' folders
                                                                      └── data/tmp/                uploads in progress, import previews
```

Two Docker containers run under Docker Compose:

| Service | Image | Role | Network exposure |
|---|---|---|---|
| `app` | built from the project `Dockerfile` (`node:24-slim`) | The whole application: HTTP server, templates, database, file storage, nightly backup | Port 3000 is `expose`d inside the Docker network only. It is **not reachable from the internet or from the host** |
| `caddy` | `caddy:2` | TLS termination, certificate issuing and renewal, redirect HTTP to HTTPS, compression, request-size limit, HSTS | Publishes 80/tcp, 443/tcp, 443/udp (HTTP/3) |

Caddy waits for the app's health check (`/health` returns `ok`) before it starts. Both services use `restart: unless-stopped`, so they come back after a crash or a reboot. Container logs rotate (10 MB × 5 files).

State lives in two places only:

1. The data folder on the host (`DATA_PATH` in `.env`; on a server `/opt/clinic-data/data`), bind-mounted to `/app/data` in the app container. It holds everything worth backing up. It lives **outside** the code folder, so a new release never touches it.
2. The Docker volume `clinic_caddy_data`, which holds certificates. Losing it only means a new certificate is requested.

---

## 3. Technology stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js 24 LTS (`"type": "module"`, `engines: ">=24"`) | Long-term support, built-in `crypto`, `fetch`, `node:test` |
| Web framework | Express 5 | Small, well known |
| Templates | EJS, server-rendered | No front-end build step, pages work without JavaScript |
| Database | SQLite via `better-sqlite3`, WAL mode | Fits 1 clinic and < 20 users; one file; simple backup |
| Passwords | `crypto.scrypt` with timing-safe compare | No extra dependency |
| Sessions | Own `sessions` table, random token in an HttpOnly cookie, only a SHA-256 of the token is stored | Revocable, no secret to manage |
| Uploads | `multer` | Streams to a temp file |
| Zip export | `archiver`, streamed | No large in-memory buffers |
| CSV import | `csv-parse` | Robust parsing; delimiter detected from the header |
| Jalali dates | `jalaali-js` (parse), `Intl` `fa-IR-u-ca-persian` (display) | Standard and accurate |
| Excel export | Own `src/lib/xlsx.js` written with `archiver` | Right-to-left sheet, no new dependency |
| Tests | Built-in `node:test` plus `fetch` against a server on a random port | 159 tests at last count |
| Deployment | Docker Compose (`app` + `caddy`) | Automatic HTTPS, reproducible install |

Runtime dependencies (the complete list): `archiver`, `better-sqlite3`, `csv-parse`, `ejs`, `express`, `jalaali-js`, `multer`. Nothing else may be added without the owner's approval.

---

## 4. Code structure

```
src/server.js            App factory createApp(), middleware order, error pages, listen, nightly backup, graceful stop
src/db.js                Opens SQLite (WAL, foreign_keys=ON, busy_timeout=5000), applies migrations/*.sql in order
src/auth.js              scrypt, sessions, lockout, requireUser / requireAdmin, same-origin (CSRF) check
src/audit.js             audit(userId, action, patientId, detail)
src/routes/              auth, dashboard, patients, documents, search, data, admin, account
src/lib/                 jalali, normalize, files, uploads, search-sql, patient-form, patient-store,
                         csv, xlsx, full-export, backup, labels
views/                   EJS templates; views/partials/ = head, sidebar, shell top/bottom, SVG sprite
public/css/              tokens.css, base.css, components.css, page-*.css
public/js/               app.js (progressive enhancement), jalali-math.js
public/fonts/            Vazirmatn (Persian text) and Geist Mono (codes), self-hosted woff2
migrations/              001_init.sql, 002_patient_ids.sql, 003_visit_referral_photo.sql
scripts/                 create-user.js (first admin and extra users), backup.js (manual backup), deploy.sh (server update)
test/                    *.test.js, helpers.js (startApp() with in-memory DB and users admin/staff)
docs/                    SETUP.md, TROUBLESHOOTING.md, DEPLOY-AGENT.md (runbook for the Claude Code session on the server)
Dockerfile, docker-compose.yml (fixed project name `clinic`, data path from `DATA_PATH`), Caddyfile, .env.example
data/                    runtime only, git-ignored
```

### 4.1 Request life cycle (back end)

`createApp()` in `src/server.js` installs middleware in this order:

1. Security headers on every response: `Content-Security-Policy: default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin`.
2. `GET /health` (unauthenticated, returns the text `ok`, no data).
3. Static files from `public/` (1 hour cache; CSS/JS links carry `?v=<server start>` so an update is never hidden by the cache).
4. Body parser for URL-encoded forms: 200 kb limit, 200 parameters. A default empty `req.body` for body-less POSTs.
5. `sessionMiddleware`: reads the cookie, looks up the SHA-256 of the token, enforces the 8 h absolute and 30 min idle limits.
6. `sameOriginOnly`: every POST must carry a same-site `Origin` header (the CSRF defence).
7. `POST /theme`: light/dark cookie; the return address must be a same-site path.
8. Auth routes (`/login`, `/logout`).
9. `requireUser`: everything below needs a signed-in user.
10. Feature routers: dashboard, patients, documents, search, data, admin, account. Admin routers additionally use `requireAdmin`.
11. A Persian 404 page and an error handler that renders Persian 4xx pages (bad URL encoding, oversized body) and a generic Persian 500 page. Server errors are logged without patient data.

The reverse-proxy setting `trust proxy` is `loopback, linklocal, uniquelocal` by default (override with `TRUST_PROXY`), so `req.ip` comes from Caddy's `X-Forwarded-For`; this matters for the per-IP sign-in lockout.

### 4.2 Front end

The front end is **server-rendered Persian RTL HTML** with no client-side framework and no build step.

- **Look:** a "sage" green accent, airy spacing, cards, chips and tabs. Light and dark themes via `prefers-color-scheme`, overridable by the theme button (cookie `theme`, `data-theme` on `<html>`). A `<meta name="darkreader-lock">` stops the Dark Reader extension from repainting the app.
- **CSS rules:** CSS logical properties only (`margin-inline-start`, `inset-inline-end`, `text-align: start`); physical `left`/`right` count as bugs. Directional icons are mirrored under `[dir="rtl"]`. Patient codes and numbers use Geist Mono with `direction: ltr; unicode-bidi: isolate`.
- **Fonts:** Vazirmatn and Geist Mono are served from `public/fonts/`. There is no request to Google, so patient page views stay private and the app works offline.
- **JavaScript:** exactly one external module, `public/js/app.js` (plus `jalali-math.js`), loaded from `views/partials/head.ejs`. It only adds the password eye and the Jalali calendar picker. Every page works without it. There is **never inline script**, which lets the CSP stay at `default-src 'self'`; tests enforce this.
- **Input handling:** the date input is a text field with the pattern `1403/05/12`. Persian and Arabic digits are accepted, and the server converts to ISO and returns a Persian error if the date is invalid.
- **Forms:** plain `<form method="post">`. Tabs use the CSS radio technique.

### 4.3 Persian text handling

Before saving and before searching, all text passes through `src/lib/normalize.js`: Persian and Arabic digits become ASCII, and Arabic `ي`/`ك` become Persian `ی`/`ک`. A SQLite function `fa_key()` is registered in `openDb()`; searches on Persian text columns compare `fa_key(column)` with the normalized value, so a name typed with Arabic letters still finds the Persian record.

---

## 5. Data

### 5.1 Database

Single SQLite file `data/clinic.db`, WAL mode, foreign keys on, busy timeout 5 s. Migrations in `migrations/NNN_*.sql` are applied in order at start-up and tracked in `schema_migrations`. **An applied migration is never edited; changes are new files.**

Main tables:

| Table | Content |
|---|---|
| `users` | username (unique), display name, role (`admin`/`staff`), scrypt hash, active flag |
| `sessions` | SHA-256 of the token, user, expiry, last seen |
| `login_attempts` | key `username|ip` and timestamp, for the lockout |
| `patients` | identity, contact, address, emergency contact, insurance, status (`active`, `pending`, `critical`, `archived`), medical fields, vitals, visit reason, referral, photo file name, timestamps, `updated_by` |
| `medications` | per-patient medication rows |
| `documents` | metadata per file: category, title, date, notes, uploader. Unique on (patient, filename) |
| `saved_searches` | per-user saved rule sets as JSON |
| `audit_log` | user, action, patient, detail, timestamp |

### 5.2 Files on disk: the folder is the source of truth

Files live in `data/patients/<code>/`. Database rows only add metadata. This means:

- A file an administrator copies into a patient folder **by hand on the server appears in the app** as "unclassified" until someone classifies it.
- A file deleted by hand **disappears from the app**.
- Deleting a patient in the app removes the row and **moves the folder to `data/trash/<code>-<timestamp>/`**; nothing is erased.
- All path building goes through `src/lib/files.js` (`patientDir()` validates `^P-\d{6}$`; `safeName()` keeps Persian letters, digits, `-`, `_`, `.` and blocks `..`, leading dots and separators). The app serves only regular, visible files of the folder.

### 5.3 Backups and export

- **Nightly backup:** the app itself runs `db.backup()` at **03:00 server time** (zone from `TZ`) into `data/backups/clinic-YYYY-MM-DD.db`, through a `.partial` file, keeping the newest 14. It also makes one at start-up if today has none. `node scripts/backup.js` makes one on demand.
- **Full zip (admin):** database snapshot, `patients.csv`, `README.txt`, and `patients/<code>/` folders each with `info.csv`; streamed and audited.
- The database backup does **not** include patient files; those are the ordinary files under `data/patients/`. A real backup strategy copies the whole `data/` folder off the server (section 9).

---

## 6. Security design

The app is internet-facing and holds real patient data, so the following rules are part of the specification.

**Authentication**
- Username and password only (no MFA, by decision D8). Passwords are at least 10 characters, hashed with scrypt, compared in constant time.
- Sign-in locks for **15 minutes after 5 failures** for the same username + IP pair. The counter is stored in the database, so a restart does not clear it.
- A session lasts **at most 8 hours** and ends after **30 minutes idle**. Cookie flags: `HttpOnly; Secure; SameSite=Strict`. Only the SHA-256 of the token is stored. Signing in again ends the old session; password reset or deactivation ends the user's sessions.
- No public sign-up. Admins create users.

**Request protection**
- Every POST must come from the same origin (the CSRF check); a missing, `null`, foreign or wrong-host `Origin` is refused.
- CSP `default-src 'self'` with no inline script; `frame-ancestors 'none'`; HSTS (`max-age=31536000`) is added by Caddy; the `Server` header is removed.
- Open redirects are blocked (only same-site paths).

**Data access**
- Every SQL statement is parameterized. Search fields and operators come from a whitelist (`src/lib/search-sql.js`); user text never becomes SQL.
- Patient files are never static files. They are served only by an authenticated route, with `Content-Disposition` and a sandboxing CSP, and each download is audited.
- Uploads are limited to PDF, JPG, PNG and DICOM; the extension **and** the magic bytes (`%PDF`, `FFD8FF`, PNG signature, `DICM` at offset 128) are checked; files over 30 MB are refused. SVG, GIF, WebP, TIFF and HEIC are rejected, and images are never decoded or resized. Caddy's limit of 35 MB sits just above, so the app's Persian message shows.
- CSV and Excel exports guard against spreadsheet formula injection.

**Accountability and hygiene**
- Audit entries for sign-in, create, edit, archive, delete, upload, download and export.
- Patient data and passwords are never logged. `data/` and `.env` are never committed.
- The container runs as the non-root `node` user (uid 1000).

---

## 7. How it runs on a server

1. `scripts/deploy.sh` runs `docker compose up -d --build`, which builds the app image in two stages. Stage one installs build tools (`python3 make g++`) and runs `npm ci --omit=dev` so `better-sqlite3` is compiled if no prebuilt binary matches. Stage two copies only `node_modules`, `src`, `views`, `public`, `migrations` and `scripts` onto a clean `node:24-slim`. The toolchain is not in the final image.
2. The `app` container starts `node src/server.js` with `NODE_ENV=production`, `DATA_DIR=/app/data`, `HOST=0.0.0.0`, `PORT=3000`. It opens (or creates) `data/clinic.db`, applies pending migrations, starts listening, and starts the nightly-backup scheduler. On `SIGTERM` it stops the scheduler, closes the HTTP server and the database cleanly.
3. A Docker `HEALTHCHECK` calls `/health` every 30 s. Caddy starts only once the app is healthy.
4. Caddy reads `Caddyfile`. The site address is `{$DOMAIN}`. For a real domain it obtains a free Let's Encrypt certificate on first contact (needs ports 80 and 443 open and the DNS A record pointing at the server) and renews it automatically. For `DOMAIN=localhost` it uses a local self-signed certificate (testing only). It then proxies everything to `app:3000`.
5. Visitors reach `https://<domain>`. HTTP is redirected to HTTPS with a 308.

### 7.1 Configuration

Three variables are read from `.env` by Compose:

| Variable | Meaning | Example |
|---|---|---|
| `DOMAIN` | Address people type, no `https://`, no slash. Must already resolve to the server | `clinic.example.com` |
| `DATA_PATH` | Folder on the host for the database, patient files and backups. On a server it must be an absolute path **outside** the release folders (`scripts/deploy.sh` refuses a relative one). Default `./data` is for local tests only | `/opt/clinic-data/data` |
| `TZ` | Server time zone; the nightly backup runs at 03:00 in it. Default `Asia/Tehran` | `Asia/Tehran` |

Optional, set in the Compose `environment` block of `app` if ever needed: `TRUST_PROXY` (override the trusted proxy list), `PORT`, `HOST`, `DATA_DIR`. There is no session secret to configure, because sessions are random tokens stored in the database.

### 7.2 Server requirements

| Item | Minimum | Notes |
|---|---|---|
| OS | Ubuntu 24.04 LTS (any modern Linux with Docker works) | |
| CPU / RAM | 1 vCPU / **2 GB** | The first image build is the heaviest moment |
| Disk | **40 GB**, more if the clinic scans heavily | Patient files and 14 backups live here |
| Network | Public IPv4, ports 22, 80, 443 reachable | 443/udp optional (HTTP/3) |
| Domain | A record pointing at the server's IP | |
| Outbound internet | Needed for the image build, Let's Encrypt and OS updates | |

---

## 8. Installation, step by step

When a Claude Code session runs on the server, it performs this installation from `docs/DEPLOY-AGENT.md`; the owner only supplies the domain, repository access and the administrator password. The steps below are the same procedure for a person.

Everything below is run on the server unless it says "on your computer". Copy each command exactly and check the "Expect" line before moving on. Replace `203.0.113.10` with your server's IP, `clinic-name.com` with your domain, and `deploy` with the Linux user you choose.

### Phase A. Obtain the infrastructure (on your computer / provider websites)

1. **Create the VPS.** Ubuntu 24.04 LTS, at least 2 GB RAM and 40 GB disk, in a region near the clinic. Add your SSH public key during creation if the provider offers it (recommended). Note the IPv4 address.
2. **Register a domain** (or use a subdomain of one you own, such as `records.clinic-name.com`).
3. **Create the DNS record.** At the registrar or DNS host, add an **A record**: name `@` (or the subdomain), value = the server IP. If the server also has IPv6, add the matching AAAA record, or leave AAAA out entirely (a wrong AAAA breaks certificate issuing).
4. **Verify propagation** on your computer:
   ```
   nslookup clinic-name.com
   ```
   Expect: the server's IP. Do not continue until it matches; Let's Encrypt will fail otherwise.

### Phase B. Secure the server

5. **First login as root:**
   ```
   ssh root@203.0.113.10
   ```
   Expect: a prompt ending in `#`.
6. **Update the system:**
   ```
   apt update && apt upgrade -y
   ```
7. **Create a non-root administrator** and give it Docker-capable sudo rights:
   ```
   adduser deploy
   usermod -aG sudo deploy
   ```
   Copy your SSH key to it (on your computer: `ssh-copy-id deploy@203.0.113.10`), then confirm that `ssh deploy@203.0.113.10` works **before** doing step 8. From here on, work as `deploy` and put `sudo` in front of privileged commands.
8. **Harden SSH** (only after step 7 works). Edit `/etc/ssh/sshd_config.d/99-hardening.conf` to contain:
   ```
   PermitRootLogin no
   PasswordAuthentication no
   ```
   Then `sudo systemctl restart ssh`. Keep your current session open and test a second login in a new terminal before closing it.
9. **Enable the firewall.** Allow SSH first, or you lock yourself out:
   ```
   sudo ufw allow 22/tcp
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw allow 443/udp
   sudo ufw enable
   sudo ufw status
   ```
   Expect: 22, 80, 443 (tcp) and 443 (udp) listed as ALLOW. Docker publishes ports by editing iptables directly, so UFW does not hide the published 80/443; that is acceptable here because only those two are published and the app port 3000 is not.
10. **Optional but recommended:** enable automatic security updates with `sudo apt install -y unattended-upgrades` and `sudo dpkg-reconfigure -plow unattended-upgrades`, and `sudo apt install -y fail2ban` to throttle SSH guessing.

### Phase C. Install Docker

11. **Install Docker Engine and the Compose plugin:**
    ```
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker deploy
    ```
    Log out and back in so the group applies.
12. **Verify:**
    ```
    docker --version
    docker compose version
    ```
    Expect: a version number from each.

### Phase D. Install the application

13. **Get the code** (read-only clone; nobody edits anything in it). Each release is a folder named with a date and time:
    ```
    sudo mkdir -p /opt/clinic && sudo chown deploy:deploy /opt/clinic
    git clone https://github.com/MMACABRE/AfshinAmini.deploy.icu.git /opt/clinic
    newest=$(ls -d /opt/clinic/20*_*/ | sort | tail -1); echo "$newest"
    ```
    If nothing is printed, no release has been published yet. Files at the repository root (outside the dated folders) belong to an old layout and are ignored.
14. **Create the data folder and the settings file** in `/opt/clinic-data`, outside the code, so that new releases never touch patient data. The app runs as uid 1000 in the container, so that user must own the data folder:
    ```
    sudo mkdir -p /opt/clinic-data/data && sudo chown deploy:deploy /opt/clinic-data && sudo chown 1000:1000 /opt/clinic-data/data
    cp "$newest/.env.example" /opt/clinic-data/.env && chmod 600 /opt/clinic-data/.env
    nano /opt/clinic-data/.env
    ```
    Set `DOMAIN=clinic-name.com` (no `https://`), `DATA_PATH=/opt/clinic-data/data`, and `TZ=` if the clinic is not on Tehran time. Save with `Ctrl+O`, `Enter`, exit with `Ctrl+X`.
15. **Build and start.** The deploy script checks the settings, builds this release, starts it and waits until it is healthy:
    ```
    bash "$newest/scripts/deploy.sh"
    ```
    The first build takes a few minutes (it may compile the SQLite module). Expect: `OK: https://clinic-name.com/health answers`. If the HTTPS check fails because the certificate is still being issued, wait a minute and run the command again. The script also writes `/opt/clinic-data/dc`, a helper that works like `docker compose` for the release now running; it is used below.
16. **Check the services:**
    ```
    /opt/clinic-data/dc ps
    ```
    Expect: both `running`; `app` shows `healthy`.
17. **Check the app internally** (port 3000 is intentionally not reachable from outside):
    ```
    /opt/clinic-data/dc exec app node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(console.log)"
    ```
    Expect: `ok`.
18. **Create the first administrator:**
    ```
    /opt/clinic-data/dc exec app node scripts/create-user.js admin admin "مدیر سیستم"
    ```
    It asks for the password twice (nothing is shown while typing). Use at least 10 characters, preferably a long passphrase unique to this system. Store it in the clinic's password manager or safe.
19. **Open the site** at `https://clinic-name.com`. Expect: the sign-in page with a padlock. The certificate is requested on the first visit; if the page does not load, wait one to two minutes and refresh. Watch it with `/opt/clinic-data/dc logs --tail 50 caddy`.
21. **Create staff accounts.** Sign in as `admin` and open *مدیریت کاربران*. Give every person their own account; never share one.

### Phase E. Acceptance tests (do these once, record the results)

| # | Test | Expect |
|---|---|---|
| 1 | `curl -I http://clinic-name.com` (on your computer) | `308` redirect to `https://` |
| 2 | `curl -I https://clinic-name.com/login` | `200`, a `Strict-Transport-Security` header, no `Server` header |
| 3 | `curl -m 5 http://203.0.113.10:3000` | Connection refused / timeout (the app port is closed) |
| 4 | Sign in, create a test patient, upload a small PDF, download it | Works; file appears under `data/patients/P-000001/` |
| 5 | Five wrong passwords for one user | Sixth attempt is locked for 15 minutes |
| 6 | Staff account opens `/admin/users` and `/data` | Forbidden (403) |
| 7 | Upload a 36 MB file | Refused with 413 |
| 8 | `/opt/clinic-data/dc exec app node scripts/backup.js` | File `/opt/clinic-data/data/backups/clinic-<today>.db` appears |
| 9 | `sudo reboot`, wait two minutes, open the site | Site comes back by itself |
| 10 | Next morning: `ls -l /opt/clinic-data/data/backups` | A new dated file from 03:00 |
| 11 | Delete the test patient (admin) | Folder moved to `data/trash/` |

The certificate (tests 1 and 2), the reboot (9) and the 03:00 run (10) cannot be verified on a development computer; they are the content of the first rollout on a real server.

---

## 9. Operation

### 9.1 Backups (the most important routine)

- The nightly backup is **on the same server**, so it protects against mistakes, not against losing the server. **Copy the whole `data/` folder off the server at least once a week.**
- From your computer:
  ```
  scp -r deploy@203.0.113.10:/opt/clinic-data/data "D:\clinic-backups\2026-10-17"
  ```
  (If the copy complains about permissions, run on the server `sudo chown -R deploy /opt/clinic-data/data` first, then `sudo chown -R 1000:1000 /opt/clinic-data/data` afterwards to give it back to the app.)
- Alternative: an admin opens *ورود و خروج داده* and downloads the full ZIP.
- Strongly recommended later: an automated off-site copy (for example `rclone` or `restic` to object storage on a cron job) of `/opt/clinic-data`.
- Keep at least one copy that is **not** reachable from the server, and **test a restore** at least once.

### 9.2 Restore

```
cd /opt/clinic-data
./dc stop app
mv data/clinic.db data/clinic.db.broken
rm -f data/clinic.db-wal data/clinic.db-shm
cp data/backups/clinic-2026-10-15.db data/clinic.db
chown 1000:1000 data/clinic.db      # use sudo if needed
./dc start app
```

Patient files are not inside the database backup. Restoring an old database leaves newer files in place; they show up as "unclassified" until classified. On a brand-new server, copy the whole saved `data/` folder in before the first start, run `chown -R 1000:1000 data`, then run `bash <newest release>/scripts/deploy.sh` as in section 8.

### 9.3 Updating the application

Every release is a new dated folder in `/opt/clinic`; the data folder is shared and never copied. After the owner publishes a release:

```
git -C /opt/clinic pull --ff-only
newest=$(ls -d /opt/clinic/20*_*/ | sort | tail -1); echo "$newest"
bash "$newest/scripts/deploy.sh"
```

The script backs up the database, builds and starts the new release with the same data folder, waits for the app to be healthy and checks `https://<domain>/health`. Pending migrations apply automatically at start-up. Earlier release folders stay on disk. On failure it prints the command that restarts the previous release. If the new release misbehaves: `/opt/clinic-data/dc logs --tail 50 app`; return to the previous release with `bash /opt/clinic/<older-folder>/scripts/deploy.sh`; if a migration already ran, restore the pre-update backup (section 9.2). The server only ever reads the repository: it never commits, edits or deletes anything in `/opt/clinic`.

### 9.4 Routine commands

| Task | Command (`dc` = `/opt/clinic-data/dc`, run from anywhere) |
|---|---|
| Status | `dc ps` |
| App logs | `dc logs --tail 100 app` |
| Proxy / certificate logs | `dc logs --tail 100 caddy` |
| Restart | `dc restart` |
| Stop / start | `dc stop` / `dc up -d` |
| New user | `dc exec app node scripts/create-user.js <username> <admin\|staff> "<display name>"` |
| Backup now | `dc exec app node scripts/backup.js` |
| Disk | `df -h /` and `du -sh /opt/clinic-data/data/*` |
| Free old Docker leftovers | `docker system prune -f` (does not touch `data/`) |
| OS updates | `sudo apt update && sudo apt upgrade -y`, then `sudo reboot` |

### 9.5 Monitoring suggestions

The app has no built-in alerting. A free external uptime monitor that requests `https://clinic-name.com/health` every few minutes and e-mails or messages on failure covers the main risk (the site being down unnoticed). Also check disk usage monthly.

---

## 10. Troubleshooting (summary)

Full text is in `docs/TROUBLESHOOTING.md`.

| Symptom | First checks |
|---|---|
| Site does not load | `dc ps`; `nslookup` the domain; `sudo ufw status` must list 80/443; internal health check (step 18) |
| Certificate error | Wait 1–2 min after first start; `dc logs --tail 50 caddy`. "NXDOMAIN" = DNS not pointing here; "rate limited" = too many restarts, wait an hour; `DOMAIN=` must be only the name |
| Disk full | `df -h /`, `du -sh data/* /var/lib/docker`, `docker system prune -f`; patient files are usually the cause, so resize the server |
| Forgot admin password | Another admin resets it in *مدیریت کاربران*; if none, create a second admin with `scripts/create-user.js` |
| User locked out | Wait 15 minutes; a restart does not clear it |
| No backup last night | `ls -l /opt/clinic-data/data/backups`; `dc logs app \| grep backup`; check `TZ`; run the backup manually |
| Upload fails | Only PDF/JPG/PNG/DCM up to 30 MB; HEIC photos must be converted; 413 means over 35 MB at Caddy |
| App cannot write data after a fresh install | `sudo chown -R 1000:1000 /opt/clinic-data/data`, then `dc restart app` |
| Error after an update | Read the app log; roll back with git; restore the pre-update backup if a migration ran |

To ask for help, collect (this contains no patient data): `dc ps`, `dc logs --tail 100 app`, `dc logs --tail 50 caddy`, `df -h /`.

---

## 11. Local development

```
npm install
npm run dev                         # node --watch src/server.js, http://localhost:3000
npm test                            # node --test "test/**/*.test.js"
node scripts/create-user.js <username> admin
```

- `DATA_DIR` defaults to `./data`. Setting `NEW_USER_PASSWORD` skips the interactive password prompt (scripts only).
- On the author's Windows machine, TCP ports 2927–3267 are reserved, so use `PORT=8080`.
- Session cookies are `Secure`; Chrome accepts them on `http://localhost`. Do not remove the flag.
- Tests use `startApp()` from `test/helpers.js`: an in-memory database with users `admin` and `staff`, both with the password `correct-horse-42`. Every POST in tests and `curl` needs a same-site `Origin` header.
- Local Docker test: `DOMAIN=localhost docker compose up -d --build`, then browse to `https://localhost` and accept the self-signed certificate. If image pulls fail, turn off any VPN or proxy that uses fake-IP DNS (198.20.0.x).

---

## 12. Project status and open items

- **Done:** slices 0–6 (foundation, Persian RTL UI, patients, documents, search/import/export, admin), slice 7 local part (backup, Docker stack, tested locally on 2026-10-16 including HTTPS, headers, upload limits, restart and restore drill), feedback round 1, inspection and bug hunt (`npm test` 159/159).
- **Next task:** mobile-browser accessibility pass (tap targets, 16 px inputs for iOS, phone navigation, touch calendar).
- **Open, needs a person:** *Human check 2*, following Section 8 on a real VPS with a real domain, confirming the Let's Encrypt certificate, the reboot test and the 03:00 backup; then the final security review.
- **Known limits:** no MFA, no database encryption at rest (rely on server disk and provider), single server (no failover), backups are local unless the operator copies them off, no built-in alerting, `SETUP.md` has not yet been proven on a real server.
- **Possible later:** per-user upload rate limit, full ARIA grid for the date picker, off-site backup automation, MFA, appointments, billing.
