# Setup guide: put the clinic site on a server

This guide takes you from nothing to a live, HTTPS site. You do not need to be a server expert. Copy each command exactly, one at a time, and read the "You should see" line after it. If something does not match, stop and see `TROUBLESHOOTING.md`.

If a Claude Code session runs on the server, it follows `DEPLOY-AGENT.md` instead of this page, and you only supply what it asks for (domain and administrator password).

You will need about one hour, a credit card for the server and the domain, and a computer with a terminal (Windows: PowerShell. Mac and Linux: Terminal).

## Part 1. Buy the pieces

1. **A server (VPS).** Any provider works (Hetzner, DigitalOcean, Contabo, ...). Choose:
   - Ubuntu **24.04** LTS
   - at least **2 GB RAM** and **40 GB disk** (patient files take space; choose more if the clinic scans a lot)
   - a location close to the clinic

   When it is created you get an **IP address** (like `203.0.113.10`) and a way to log in as `root`.
2. **A domain name** (like `clinic-name.com`). Any registrar works.
3. **Point the domain at the server.** In the registrar's DNS settings, add an **A record**: name `@` (or a subdomain such as `records`), value = the server's IP address. It can take from a few minutes to a few hours to spread.

   You can check from your own computer: `nslookup clinic-name.com` should show the server's IP.

> The site address used below is `clinic-name.com`. Replace it with yours every time.

## Part 2. Prepare the server

4. **Log in.** In your terminal (replace the IP):

   ```
   ssh root@203.0.113.10
   ```

   Type `yes` if asked about authenticity, then the password the provider gave you. You should see a prompt ending in `#`.
5. **Update the system:**

   ```
   apt update && apt upgrade -y
   ```
6. **Install Docker:**

   ```
   curl -fsSL https://get.docker.com | sh
   ```

   Check: `docker --version` prints a version number, and `docker compose version` does too.
7. **Turn on the firewall.** This allows only SSH (22) and the website (80, 443). Run these three lines. **Do the first line before the second**, or you lock yourself out.

   ```
   ufw allow 22/tcp
   ufw allow 80,443/tcp
   ufw enable
   ```

   Type `y` when asked. Also run `ufw allow 443/udp` (faster connections).

## Part 3. Install the app

8. **Get the code** (read-only; you never edit anything in this folder):

   ```
   git clone https://github.com/MMACABRE/AfshinAmini.deploy.icu.git /opt/clinic
   newest=$(ls -d /opt/clinic/20*_*/ | sort | tail -1); echo "$newest"
   ```

   Each published version is a folder named with a date and time. The last line prints the newest one. If it prints nothing, no version has been published yet.
9. **Create the data folder and the settings file.** They live in `/opt/clinic-data`, **outside** the code folder, so a new version of the code never touches your patients:

   ```
   mkdir -p /opt/clinic-data/data && chown 1000:1000 /opt/clinic-data/data
   cp "$newest/.env.example" /opt/clinic-data/.env
   chmod 600 /opt/clinic-data/.env
   nano /opt/clinic-data/.env
   ```

   Change `DOMAIN=` to your domain (no `https://`). Set `DATA_PATH=/opt/clinic-data/data`. Change `TZ=` if the clinic is not in Tehran time. Save with `Ctrl+O`, `Enter`, then leave with `Ctrl+X`. (The data folder is owned by user id 1000 because the app runs as that ordinary user.)
10. **Start everything:**

    ```
    bash "$newest/scripts/deploy.sh"
    ```

    The first time this takes a few minutes. It ends with `OK: https://clinic-name.com/health answers`. If it says the HTTPS check failed, wait a minute (the certificate is still being issued) and run the same command again.
11. **Check it runs:**

    ```
    /opt/clinic-data/dc ps
    ```

    Both services should say `running` (the app also says `healthy`). `/opt/clinic-data/dc` is a helper that works like `docker compose` for the version that is running; use it for every command in this guide.
12. **Create the first administrator:**

    ```
    /opt/clinic-data/dc exec app node scripts/create-user.js admin owner "مدیر سیستم"
    ```

    It asks for a password twice (nothing shows while you type). Use at least 10 characters and keep it safe. This first account is the **owner**: it always has every permission and nobody can restrict or delete it.
13. **Open the site.** In your browser go to `https://clinic-name.com`. You should see the sign-in page with a padlock. The certificate is obtained automatically the first time; if the page does not load, wait a minute and refresh.
14. **Sign in as `admin`, then create the staff accounts** under *مدیریت کاربران*. Staff can view and edit patients and documents. Only administrators can delete, import, download everything, and see the activity log.

## Part 4. Daily life

### Backups
- The app writes a database backup **every night at 03:00** into `/opt/clinic-data/data/backups/` and keeps the last 14.
- The patient files are stored as ordinary files in `/opt/clinic-data/data/patients/`.
- The data folder is private: the app closes it to every account except its owner (user id 1000) and root (mode 700). Copy it as `root`, as in the command below, or with `sudo`; an ordinary account gets "Permission denied".
- **A backup that stays on the same server is not enough.** If the server dies, both are lost. **Once a week, copy the whole data folder to your own computer.** From your computer (replace the IP and the destination):

  ```
  scp -r root@203.0.113.10:/opt/clinic-data/data "D:\clinic-backups\2026-10-16"
  ```

  Another way: sign in as admin, open *ورود و خروج داده* and press *دانلود فایل ZIP*. It contains the database, a spreadsheet and every patient's files.
- To make a backup right now: `/opt/clinic-data/dc exec app node scripts/backup.js`

### Update to a newer version
```
git -C /opt/clinic pull --ff-only
newest=$(ls -d /opt/clinic/20*_*/ | sort | tail -1); echo "$newest"
bash "$newest/scripts/deploy.sh"
```
Each new version arrives as a new dated folder in `/opt/clinic`. The script makes a backup, starts the new version with the same data folder, and checks that the site answers. If it fails it prints the command that restarts the previous version (its folder is still there). Your patients and files are never touched.

### Restore a backup
1. Go to the data folder and stop the app: `cd /opt/clinic-data && ./dc stop app`
2. Keep the current database aside: `mv data/clinic.db data/clinic.db.broken; rm -f data/clinic.db-wal data/clinic.db-shm`
3. Put the backup in place (use the date you want): `cp data/backups/clinic-2026-10-15.db data/clinic.db`
4. Give the app ownership of the restored file: `chown 1000:1000 data/clinic.db`
5. Start the app: `./dc start app`

Patient files are not part of the database backup; they are in `data/patients/`. Restoring an old database does not delete newer files. They show up as "unclassified" until someone classifies them.

### Restart and reboot
Everything restarts by itself after a reboot (`restart: unless-stopped`). To test it once: `reboot`, wait two minutes, then open the site.

### Look at the logs
```
/opt/clinic-data/dc logs --tail 100 app
/opt/clinic-data/dc logs --tail 100 caddy
```

## Safety checklist
- [ ] The first administrator has a strong password nobody else knows.
- [ ] The firewall shows only 22, 80, 443 (`ufw status`).
- [ ] A copy of the data folder is on a different computer or disk.
- [ ] Each staff member has their own account (never share one).
- [ ] The server is updated now and then: `apt update && apt upgrade -y`, then `reboot`.
