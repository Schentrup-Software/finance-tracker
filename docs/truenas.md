# Install on TrueNAS

You need TrueNAS SCALE with Docker-based apps (24.10 "Electric Eel" or newer). The app is
one container: PocketBase serves the app, the API and the admin dashboard on one port, and
keeps all data in one folder that you put on a dataset.

## 1. Make a dataset for the data

1. **Datasets** → pick your pool (these steps use `tank`) → **Add Dataset**. Name it
   `apps/finance-tracker/pb_data`, or make `apps/finance-tracker` first and `pb_data` inside
   it. The **Apps** preset is fine.
2. Give the `apps` user (ID 568) read and write access: select the dataset →
   **Permissions** → **Edit** → set **Owner (user)** and **Owner (group)** to `apps`, tick
   **Apply User** and **Apply Group**, and save.

The container runs as `apps` (`user: "568:568"` in the YAML), so it can only write here.

## 2. Install the app

1. **Apps** → **Discover Apps** → **⋮** next to **Custom App** → **Install via YAML**.
2. Name it `finance-tracker`.
3. Paste [deploy/truenas.yaml](../deploy/truenas.yaml):

   ```yaml
   services:
     finance-tracker:
       image: ghcr.io/schentrup-software/finance-tracker:latest
       pull_policy: always
       user: "568:568"
       ports:
         - "30680:8080"
       volumes:
         - /mnt/tank/apps/finance-tracker/pb_data:/pb/pb_data
       healthcheck:
         test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/api/health"]
         interval: 30s
         timeout: 5s
         retries: 3
       restart: unless-stopped
   ```

   Change `/mnt/tank/...` to your dataset's path, and the **left** port number if 30680 is
   already in use.
4. **Save**. When the app shows **Running**, open `http://<your-nas-ip>:30680`.

If TrueNAS can't pull the image: GitHub creates the package as private the first time the
workflow publishes it. Open the package on GitHub (the repo's **Packages** section) →
**Package settings** → change visibility to **Public**, or add a `ghcr.io` login with a
read-only token under **Apps** → **Configuration** → **Manage Container Images**/registry
settings.

## 3. First run

1. **Your account.** The first visit to the app shows **Create account**. That email and
   password are your login. Sign-up closes as soon as it exists.
2. **Admin dashboard account.** You need a superuser for the PocketBase dashboard at
   `http://<your-nas-ip>:30680/_/` (to add another user, or to mint a long-lived token for
   n8n). In TrueNAS: **Apps** → `finance-tracker` → **Workloads** → the container's
   **Shell** button, then run:

   ```sh
   /pb/pocketbase superuser upsert you@example.com 'a-long-password' --dir=/pb/pb_data
   ```

   (The container log also prints a one-time setup link. It says `0.0.0.0:8080`; replace
   that with `<your-nas-ip>:30680` if you'd rather use it.)
3. **More people** (a spouse, say): in the dashboard, **users** → **New record**. Note
   that each user has their own separate budget, debts and assets.

## Updating

Every push to `main` publishes a new `latest` image. In TrueNAS: **Apps** →
`finance-tracker` → **Stop**, then **Start** (`pull_policy: always` pulls the new image on
start). Schema changes in `pb_migrations/` apply themselves on start, and your data stays
in the dataset.

## Backups

Everything (your data, users and settings) is in the `pb_data` dataset. Add a **Periodic
Snapshot Task** for it under **Data Protection**, and replicate or cloud-sync it like any
other dataset. To restore, stop the app, roll the dataset back, and start it again.

The dashboard also has **Settings** → **Backups** for one-off zip backups.

## HTTPS and n8n

- n8n on the same network can call `http://<your-nas-ip>:30680/api/...`. See
  [api.md](api.md) for authentication and the sync endpoint.
- To reach it from outside your home, put it behind a reverse proxy with HTTPS (Nginx Proxy
  Manager, Traefik, Caddy, or a Cloudflare/Tailscale tunnel) pointing at port 30680. Don't
  expose plain HTTP to the internet: it carries your password and API tokens.
- Behind a proxy, set **Settings** → **Application** → **Application URL** in the dashboard
  to the public URL, and turn on **Settings** → **Rate limits** if it's reachable from the
  internet.

## Troubleshooting

- **App stays "Deploying" or restarts, log says `permission denied` on `pb_data`:** the
  `apps` user can't write the dataset. Redo the permissions in step 1.
- **Port in use:** change the left number in `"30680:8080"` and save.
- **Forgot your password:** in the dashboard, **users** → your record → set a new password.
  No superuser yet? Create one from the container shell (step 3.2).
