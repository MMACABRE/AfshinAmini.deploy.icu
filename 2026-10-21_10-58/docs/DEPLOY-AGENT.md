# Deployment runbook for the agent on the production server

This file is for the Claude Code session that runs **on the production VPS**. It installs, updates and repairs the live site from the public GitHub repository `MMACABRE/AfshinAmini.deploy.icu` (branch `main`). The site holds real patient records, so read the rules first.

## How the server is laid out

Two folders, kept strictly apart:

| Folder | Holds | Who writes to it |
|---|---|---|
| `/opt/clinic` | A clone of the public repository: **code only**. Every release is a folder named with a date and time (for example `2026-10-17_14-30`). Files in the repository root (outside those folders) belong to an old layout; ignore them | Nobody. You only run `git pull --ff-only` here. You never create, edit or delete a file in it |
| `/opt/clinic-data` | `.env` (settings), `data/` (database, patient files, backups, trash), and two small files written by the update script: `current-release` and `dc` | The app, and `scripts/deploy.sh` |

Because patient data lives outside the code, publishing a new release never touches it. Never put `.env` or `data/` inside `/opt/clinic`.

`/opt/clinic-data/dc` runs `docker compose` for the release that is deployed now. Use it for every routine command (`dc ps`, `dc logs --tail 50 app`, `dc restart`, `dc exec -T app node scripts/backup.js`). It exists after the first successful deploy. The newest release folder is:

```
newest=$(ls -d /opt/clinic/20*_*/ | sort | tail -1)
```

## Rules

1. **Never touch patient data.** Do not read, print, copy, move or delete anything under `/opt/clinic-data/data/patients/`, `data/trash/` or inside `data/clinic.db`. Do not open the database with `sqlite3` or any query. Backups and restores move whole files only.
2. **The repository is read-only for you.** Only `git pull --ff-only`. Never commit, push, edit, create or delete anything inside `/opt/clinic`. All code changes are made on the owner's computer and published by the owner.
3. **Never print secrets.** No passwords, tokens or `.env` contents in chat or logs. Show `.env` keys without values if you must show it.
4. **Back up before every change.** `scripts/deploy.sh` does this for you.
5. **Do not run destructive commands** without the owner's yes: `docker compose down -v`, `docker system prune -a`, `rm -rf /opt/clinic-data/data`, `git reset --hard`, `git clean`, anything with `--force`. The folder `/opt/clinic-data/data` and the Docker volume `clinic_caddy_data` must survive every operation.
6. **Do not change code or config to make a check pass.** If a step fails, report the exact error. Fixing the app is the developer's job; fixing the server (firewall, Docker, DNS, permissions) is yours.
7. When a step needs the owner, write `needs input:` and say exactly what they must do. Do not guess a domain, a password or an account name.

## What only the owner can supply

| Item | Why you cannot do it |
|---|---|
| The domain name, and its DNS **A record** pointing at this server's public IP | It lives at the registrar |
| The administrator username and password | The owner chooses and keeps them |
| A published release (a dated folder in the repository) | The owner decides when to publish. If `ls -d /opt/clinic/20*_*/` finds nothing, write `needs input:` and ask the owner to publish |
| Off-server backup destination | The owner decides where copies go |

## First install

Run as a sudo-capable user. Stop at the first failure.

1. **Check the machine.** `lsb_release -d` (Ubuntu 24.04 expected), `nproc`, `free -h` (at least 2 GB RAM), `df -h /` (at least 40 GB), `curl -s https://api.ipify.org` (public IP).
2. **Check DNS.** `getent hosts <domain>` must print this server's public IP. If not: `needs input:` ask the owner to fix the A record. Also confirm there is **no wrong AAAA record** (`getent ahostsv6 <domain>`); a wrong one breaks certificate issuing.
3. **Update the OS.** `sudo apt update && sudo apt upgrade -y`. Reboot only if the kernel was updated and tell the owner first.
4. **Firewall.** Allow SSH *first*, so you do not lock out the owner:
   ```
   sudo ufw allow 22/tcp
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw allow 443/udp
   sudo ufw --force enable
   sudo ufw status
   ```
   If SSH runs on another port, allow that port instead. Optional and recommended: `sudo apt install -y unattended-upgrades fail2ban`.
5. **Docker.** If `docker compose version` fails: `curl -fsSL https://get.docker.com | sudo sh`, then add the working user to the `docker` group (`sudo usermod -aG docker "$USER"`) and start a new shell, or prefix the docker commands with `sudo`. Verify `docker --version` and `docker compose version`.
6. **Code (read-only clone).** `sudo mkdir -p /opt/clinic && sudo chown "$USER": /opt/clinic && git clone https://github.com/MMACABRE/AfshinAmini.deploy.icu.git /opt/clinic`. Then find the release: `newest=$(ls -d /opt/clinic/20*_*/ | sort | tail -1); echo "$newest"`. If it prints nothing, `needs input:` (no release published yet).
7. **Data folder and settings.** These live outside the code:
   ```
   sudo mkdir -p /opt/clinic-data/data && sudo chown "$USER": /opt/clinic-data && sudo chown 1000:1000 /opt/clinic-data/data
   cp "$newest/.env.example" /opt/clinic-data/.env && chmod 600 /opt/clinic-data/.env
   ```
   Edit `/opt/clinic-data/.env`: set `DOMAIN=` (name only, no `https://`, no slash), `DATA_PATH=/opt/clinic-data/data`, and `TZ=` (default `Asia/Tehran`). Check without showing secrets: `grep -E '^(DOMAIN|DATA_PATH|TZ)=' /opt/clinic-data/.env`. The container runs as uid 1000; without the `chown 1000:1000` the app cannot write.
8. **Build and start.** `bash "$newest/scripts/deploy.sh"`. The first build takes a few minutes. It ends with `OK: https://<domain>/health answers`. If the certificate is not ready yet it reports the HTTPS check as failed even though the app is healthy: wait a minute and read `docker compose --env-file /opt/clinic-data/.env -f "$newest/docker-compose.yml" logs --tail 50 caddy`, then run the script again.
9. **Check the services.** `/opt/clinic-data/dc ps`: `app` is `healthy`, `caddy` is `running`.
10. **Create the first administrator.** `needs input:` ask the owner for the username and a password of at least 10 characters. If the owner asks you to generate one, make a long random passphrase, show it to them **once** in chat, and tell them to store it in their password manager. Pass it through the environment only, never as an argument that lands in history:
    ```
    read -rsp 'Password: ' P; echo
    /opt/clinic-data/dc exec -T -e NEW_USER_PASSWORD="$P" app node scripts/create-user.js <username> owner "مدیر سیستم"; unset P
    ```
    Expect `Created owner "<username>"`. The owner always has every permission and cannot be restricted or deleted from the web pages. On a server that already has users, the update makes the oldest active admin the owner automatically; do not create another.
11. **Public check.** Run the acceptance tests below. If the certificate fails, read the caddy logs and use `TROUBLESHOOTING.md` (NXDOMAIN means DNS, rate limit means wait an hour).

## Acceptance tests

Record each result in your report to the owner.

| # | Check | Expect |
|---|---|---|
| 1 | `curl -sI http://<domain>` | `308` redirect to `https://` |
| 2 | `curl -sI https://<domain>/login` | `200`, a `strict-transport-security` header, no `server` header |
| 3 | `curl -s -m 5 -o /dev/null -w '%{http_code}' http://<public-ip>:3000` | Fails (`000`): the app port is closed |
| 4 | `curl -s https://<domain>/health` | `ok` |
| 5 | `/opt/clinic-data/dc exec -T app node scripts/backup.js`, then `ls -l /opt/clinic-data/data/backups` | A file `clinic-<today>.db` |
| 6 | `sudo ufw status` | Only SSH, 80, 443 (tcp), 443 (udp) allowed |
| 7 | `/opt/clinic-data/dc ps` after `sudo reboot` (ask the owner first) | Both services come back by themselves |
| 8 | Next morning: `ls -l /opt/clinic-data/data/backups` | A new file dated from 03:00 server time |

Tests 7 and 8 are the checks that cannot be done on a development computer. Report them to the owner when done.

Sign-in, upload and role checks need an interactive login and patient-style data. Ask the owner to do one pass in the browser: sign in, create a **test** patient, upload a small PDF, download it, then delete the test patient (it moves to `data/trash/`). Do not do this with a real patient.

## Update to a new release

When the owner says a new release is published:

```
git -C /opt/clinic pull --ff-only
newest=$(ls -d /opt/clinic/20*_*/ | sort | tail -1); echo "$newest"
bash "$newest/scripts/deploy.sh"
```

The script backs up the database, builds and starts the new release with the **same** data folder, waits for the app to be healthy and checks `https://<domain>/health`. Earlier release folders stay on disk. Database migrations apply automatically at start-up. On failure it prints the command that restarts the previous release. If `git pull --ff-only` refuses, do not force it: report `git status` to the owner.

Afterwards check the log for errors: `/opt/clinic-data/dc logs --tail 50 app`.

## Routine care

| Task | Command |
|---|---|
| Status | `/opt/clinic-data/dc ps` |
| App logs | `/opt/clinic-data/dc logs --tail 100 app` |
| Proxy and certificate logs | `/opt/clinic-data/dc logs --tail 100 caddy` |
| Restart | `/opt/clinic-data/dc restart` |
| Backup now | `/opt/clinic-data/dc exec -T app node scripts/backup.js` |
| Disk | `df -h /` and `du -sh /opt/clinic-data/data/*` (sizes only) |
| OS security updates | `sudo apt update && sudo apt upgrade -y`, reboot with the owner's yes |

Check disk use and `ls -l /opt/clinic-data/data/backups` whenever the owner asks for a health report. The nightly backup keeps 14 files **on this server only**; remind the owner that a copy must also leave the server.

## Backups off the server

The nightly backup protects against mistakes, not against losing the server. The owner must copy `/opt/clinic-data` (at least its `data/` folder) to another place at least weekly. Two ways:

- From the owner's computer: `scp -r <user>@<server-ip>:/opt/clinic-data/data <destination>`. The app sets the data folder to mode 700 (owner uid 1000 and root only) on every start, so an ordinary account is blocked; this is intended. If permissions block it, run `sudo chown -R <user> /opt/clinic-data/data`, then give it back afterwards with `sudo chown -R 1000:1000 /opt/clinic-data/data`.
- An admin downloads the full ZIP from *ورود و خروج داده* in the app.

If the owner wants it automated, propose `restic` or `rclone` on a cron job to storage they choose, and wait for their decision and credentials.

## Restore and rollback

- **Database from a backup** (only when the owner asks): `/opt/clinic-data/dc stop app`, then `mv /opt/clinic-data/data/clinic.db /opt/clinic-data/data/clinic.db.broken; rm -f /opt/clinic-data/data/clinic.db-wal /opt/clinic-data/data/clinic.db-shm`, then `cp /opt/clinic-data/data/backups/clinic-YYYY-MM-DD.db /opt/clinic-data/data/clinic.db`, `sudo chown 1000:1000 /opt/clinic-data/data/clinic.db`, `/opt/clinic-data/dc start app`.
- **Previous release:** run `bash <older-release-folder>/scripts/deploy.sh`. The older folders are still in `/opt/clinic`. If a database change already ran in the newer release, restore the backup made by the failed update first.
- Patient files are not inside the database backup. After restoring an old database, newer files appear as "unclassified" until someone classifies them. That is expected.

## Report format

End every session with a short report to the owner: what you did, each acceptance result (pass or fail with the exact error), anything marked `needs input:`, and the release now deployed (`cat /opt/clinic-data/current-release`). Never include patient data or secrets.

## Known state of the project

- The Docker stack passed a full local test (build, HTTPS with a self-signed certificate, headers, upload limits, backup, restart, restore, and deploying a second release folder with the data kept). The Let's Encrypt certificate, the reboot test and the 03:00 backup have **not** yet been proven on a real server. This install is that proof, so report faithfully, including every error.
- The mobile accessibility pass is planned but not done. It is a code change for the developer, not a deployment issue.
