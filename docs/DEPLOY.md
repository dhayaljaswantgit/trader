# Deploy on your server (Coolify)

The app runs as one container (API + web UI on port 4000) and uses your **existing Postgres**.
Coolify's proxy serves it on your domain with **HTTPS**, and a username + password login protects every page.

```
Browser ──HTTPS──► Coolify proxy (your domain) ──► app container :4000 ──► your Postgres
```

## 1. Put the code in a private Git repo

Coolify deploys from Git. The repo **must be private**. `.env` and `data/` are already in `.gitignore`, so no credentials get committed.

```bash
git remote add origin git@github.com:<you>/dhan-ai-trader.git   # private repo
git push -u origin master
```

## 2. Database (existing Postgres)

Create an **empty database** for the app in your Postgres, e.g. `CREATE DATABASE dhan_trader;`. Use a dedicated user if you can. The app creates all its tables itself on first start, through migrations.

The Postgres host must be reachable **from inside the container**:
- **Postgres is a Coolify resource:** use its **internal URL** (Postgres resource → "Postgres URL (internal)"). In this app's settings, turn on **"Connect to Predefined Network"** so both containers share Coolify's network.
- **Postgres runs directly on the server:** use `host.docker.internal`, or the docker bridge IP `172.17.0.1`, as the host. Postgres must listen on that interface, and `pg_hba.conf` must allow the docker subnet.
- **Postgres is somewhere else:** use its normal host and port.

## 3. Coolify

1. **+ New Resource → Private Repository** (connect the GitHub App, or use a deploy key) → choose the repo.
2. **Build Pack: Docker Compose**, with compose file `docker-compose.yml`.
3. **Domains: leave EMPTY.** The Caddy labels in docker-compose.yml route `https://trade.itspar.com` → port 4000 and issue HTTPS. DNS: A record `trade` → server IP.
4. **Environment Variables:**

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | your existing Postgres, e.g. `postgresql://user:pass@host:5432/dhan_trader` |
   | `APP_USER` | your login name, e.g. `jassu` |
   | `APP_PASSWORD` | a strong password (this is the browser login) |
   | `BROKER` | `DHAN` |
   | `CRYPTO_USDINR` | `93` (optional) |

   **Google sign-in (recommended)**: add these too. Then only the listed emails can open the app, and APP_USER/APP_PASSWORD are ignored.

   | Name | Value |
   |---|---|
   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from Google Cloud Console (see below) |
   | `ALLOWED_EMAILS` | `you@gmail.com,friend@gmail.com` |
   | `PUBLIC_URL` | `https://trade.itspar.com` |
   | `SESSION_SECRET` | a long random string (`openssl rand -hex 32`) |

   Google Cloud Console → APIs & Services → **OAuth consent screen** (External; add your emails as test users) → **Credentials → Create OAuth client ID → Web application**:
   - Authorized redirect URI: `https://trade.itspar.com/auth/google/callback`
   - For local testing, also add `http://localhost:4000/auth/google/callback`

5. **Deploy.** The first build takes a few minutes. Database migrations run automatically on every start.
6. Open **`https://trade.itspar.com`** and log in with APP_USER / APP_PASSWORD.

## 4. First-time setup in the app (on the server)

Credentials are **not** copied from your laptop. Enter them again, once:

- **Settings → ⚡ Instant login**: Dhan Client ID, PIN, TOTP secret, and **Auto-login ON**. The daily token then renews by itself.
- **Trade Setup** (Dhan and ₿ Delta): strategies, instruments, and the **Auto-start engine** switch ON.
- **💬 Market Chat**, one of these:
  - **Local Claude Code**: log in once inside the container:
    ```bash
    docker exec -it $(docker ps -qf name=app) claude    # then /login, follow the link, then exit
    ```
    The login is kept in the `trader-data` volume.
  - **API key**: Market Chat → provider "Anthropic API key" → paste the key.

Optional: to keep your laptop's history (trades, backtests, strategies), copy the database once:
```bash
# laptop
pg_dump -Fc dhan_trader > trader.dump
scp trader.dump server:/tmp/
# server
pg_restore -d "$DATABASE_URL" --clean --if-exists --no-owner /tmp/trader.dump
```
Then restart the app in Coolify.

## 5. Backups

Back up your Postgres database (`dhan_trader`) along with your other DB backups, and the `trader-data` volume (Dhan/TOTP credentials, settings, Claude login).

```bash
pg_dump -Fc "$DATABASE_URL" > ~/backup-$(date +%F).dump
```

If the Postgres is a Coolify resource, its scheduled backups cover this database too.

## Safety notes

- The app is **PAPER only**. No live order route exists in the code.
- The app is on the public internet: use a **long, random APP_PASSWORD**, and always HTTPS (never plain http). Optionally restrict the domain to your IP in Coolify/firewall.
- `trader-data` contains your Dhan PIN and TOTP secret. Keep server SSH access locked down (key login only).
- One-click consent login (Dhan API key flow) needs `DHAN_REDIRECT_URL=https://trade.itspar.com/api/dhan/oauth/callback`, set both in Coolify and on web.dhan.co. **Instant login (PIN + TOTP) needs nothing extra** and is recommended.
- Health check: `https://trade.itspar.com/healthz` (no login needed, shows nothing private).
