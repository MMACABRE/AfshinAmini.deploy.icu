# Troubleshooting

Run every command on the server, in the data folder: `ssh root@YOUR-IP`, then `cd /opt/clinic-data`. The helper `./dc` there works like `docker compose` for the version of the site that is running. The code lives separately in `/opt/clinic` (one dated folder per version) and is never edited.

## The site does not load
1. Is the app running? `./dc ps`. Both `app` and `caddy` must say `running`.
   - Not running: `./dc up -d`
   - `app` keeps restarting: `./dc logs --tail 50 app` and read the last error.
2. Does the domain point at this server? On your own computer: `nslookup clinic-name.com`. The IP must be the server's. If not, fix the A record at the registrar and wait.
3. Is the firewall open? `ufw status` must list 80 and 443.
4. Does the app answer inside the server? `curl -s http://localhost:3000/health` is not reachable from outside by design. Use: `./dc exec app node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(console.log)"`. It prints `ok`.

## Certificate error or "connection not private"
- Right after the first start, wait 1 to 2 minutes and refresh. The certificate is requested automatically.
- Still wrong: `./dc logs --tail 50 caddy`.
  - "no such host" or "NXDOMAIN": the domain does not point at the server yet.
  - "too many requests" or "rate limited": you restarted many times; wait an hour.
  - "connection refused" on port 80 or 443: the firewall or another program blocks the ports.
- The `DOMAIN=` line in `/opt/clinic-data/.env` must be only the name, for example `clinic-name.com`. After changing it: `./dc up -d`.

## The disk is full
1. See what is big: `df -h /` and `du -sh data/* /var/lib/docker`.
2. Old backups: they are only 14 files. Old Docker leftovers: `docker system prune -f` (safe; it does not touch your data folder).
3. Logs are rotated automatically (10 MB x 5 files).
4. Patient files are in `data/patients/`. If they are the reason, move to a bigger disk (ask your provider to resize the server).

## I forgot the administrator password
- If another administrator exists: they open *مدیریت کاربران* and set a new password for you.
- If you are the only administrator, create a new one and use it to reset the old account:
  ```
  ./dc exec app node scripts/create-user.js admin2 admin "مدیر"
  ```

## A user is locked out
After 5 wrong passwords the sign-in is blocked for 15 minutes. Wait 15 minutes and try again. Restarting the app does not clear the block, because it is stored in the database.

## Restore yesterday's backup
See "Restore a backup" in `SETUP.md`. In short:
```
./dc stop app
mv data/clinic.db data/clinic.db.broken; rm -f data/clinic.db-wal data/clinic.db-shm
cp data/backups/clinic-YYYY-MM-DD.db data/clinic.db
chown 1000:1000 data/clinic.db
./dc start app
```
List the available days: `ls data/backups`.

## The server rebooted
Nothing to do. Both services start again by themselves. Check after two minutes: `./dc ps`. If they are not running: `./dc up -d`.

## There is no backup from last night
- `ls -l data/backups`. The newest file should have today's or yesterday's date.
- `./dc logs app | grep backup` shows "backup written" or "backup failed" with the reason (often a full disk).
- Make one now: `./dc exec app node scripts/backup.js`
- The time zone matters: the job runs at 03:00 in the `TZ=` zone from `/opt/clinic-data/.env`.

## An upload fails
- Files must be PDF, JPG, PNG or DCM, and at most 30 MB. iPhone HEIC photos must be converted to JPG first.
- "413" or a blank page after a very large file: the file is over the 35 MB limit in Caddy.

## After an update the site shows an error
1. `./dc logs --tail 50 app`
2. Go back to the previous version: list the versions with `ls -d /opt/clinic/20*_*/`, then run `bash /opt/clinic/<older-folder>/scripts/deploy.sh`. Your data is unchanged; if a database change was applied, restore the backup made before the update.

## Everything is broken and I need help
Collect this and send it to the developer (it contains no patient data):
```
./dc ps
./dc logs --tail 100 app
./dc logs --tail 50 caddy
df -h /
```
