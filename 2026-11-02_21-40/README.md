# Patient manager: deployment repository

A Persian (right-to-left, Jalali calendar) patient-records web app for one private clinic. Node.js, Express, SQLite, Docker Compose and Caddy (automatic HTTPS).

This repository contains what is needed to run the site on a Linux server.

- `specifications.md`: what the system is, how it works, security design, and a complete install guide.
- `docs/DEPLOY-AGENT.md`: runbook for a Claude Code session that installs and updates the site on the server.
- `docs/SETUP.md`: the same install in plain steps for a person.
- `docs/TROUBLESHOOTING.md`: symptom to exact command.
- `scripts/deploy.sh`: updates a running server to the latest version.

Quick start on a server with Docker: copy `.env.example` to `.env`, set `DOMAIN`, run `mkdir -p data && sudo chown 1000:1000 data`, then `docker compose up -d --build`.
