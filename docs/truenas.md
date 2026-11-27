# Install on TrueNAS

You need TrueNAS SCALE with Docker-based apps (24.10 "Electric Eel" or newer). The app is
one container: PocketBase serves the app, the API and the admin dashboard on one port, and
keeps all data in one folder that you put on a dataset.

## 1. Make a dataset for the data

1. **Datasets** → pick your pool (these steps use `tank`; use your pool's name) →
   **Add Dataset**. Name it `apps/finance-tracker/pb_data`, or make `apps/finance-tracker`
   first and `pb_data` inside it. The **Apps** preset is fine.
2. Note the dataset's full path, e.g. `/mnt/tank/apps/finance-tracker/pb_data`. You paste it
   into the YAML next.

On start, the container makes this folder belong to the `apps` user (ID 568) and then runs
PocketBase as that user. If the dataset's ACL doesn't allow that, give `apps` read/write
access yourself: select the dataset → **Permissions** → **Edit** → set **Owner (user)** and
**Owner (group)** to `apps`, tick **Apply User** and **Apply Group**, and save.

## 2. Install the app

1. **Apps** → **Discover Apps** → **⋮** next to **Custom App** → **Install via YAML**.
2. Name it `finance-tracker`.
3. Paste [deploy/truenas.yaml](../deploy/truenas.yaml):

   ```yaml
   services:
     finance-tracker:
       image: ghcr.io/schentrup-software/finance-tracker:latest
       pull_policy: always
       ports:
         - "30680:8080"
       volumes:
         - /mnt/tank/apps/finance-tracker/pb_data:/pb/pb_data
       environment:
         PUID: "568"
         PGID: "568"
       healthcheck:
         test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/api/health"]
         interval: 30s
         timeout: 5s
         retries: 3
         start_period: 60s
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
   password are your login, and you become the **head of the household**. Sign-up closes
   as soon as the account exists.
2. **Admin dashboard account.** You need a superuser for the PocketBase dashboard at
   `http://<your-nas-ip>:30680/_/` (to look at the raw data; n8n's token
   comes from the app's **API tokens** page). In TrueNAS: **Apps** → `finance-tracker` → **Workloads** → the container's
   **Shell** button, then run:

   ```sh
   su-exec 568:568 /pb/pocketbase superuser upsert you@example.com 'a-long-password' --dir=/pb/pb_data
   ```

   (The container log also prints a one-time setup link. It says `0.0.0.0:8080`; replace
   that with `<your-nas-ip>:30680` if you'd rather use it.)
3. **More people** (a spouse, say): in the app, the people button at the top right →
   **Add a person**, with their email and a password to share with them. Everyone in the
   household shares the same budget, debts and assets. Only the head adds, removes or
   resets the password of people. (A user a superuser makes in the dashboard starts a
   separate household of their own.)

## Troubleshooting: stuck on "Deploying", then "Stopped"

The container started and then exited before PocketBase was up. To see why, open
**Apps** → `finance-tracker` → **Workloads** → the container's **Logs** button (the page
icon). Logs only exist once the container has run, so if it's empty, click **Start**,
wait a few seconds and open the logs again. Lines from the app start with `finance-tracker:`.

- **"user 568 can't write to /pb/pb_data"**, or a PocketBase error mentioning
  `permission denied` and `pb_data`: the `apps` user can't write to the dataset. Give `apps`
  read/write access as in step 1, or remove the `user: "568:568"` line if your YAML still has
  it (older copies did). The container then fixes the folder's owner itself.
- **The path in `volumes:` doesn't exist**, for example your pool isn't called `tank`.
  Docker then makes an empty root-owned folder there, which isn't your dataset. Check
  **Datasets** for the real path, fix it in the YAML (**Apps** → `finance-tracker` →
  **Edit**), and save.
- **The port is taken**: change the left number in `ports:`.
- **Old image**: `pull_policy: always` fetches the newest image on every start. **Edit** →
  **Save** without changes also pulls it again.

## Optional: OpenClaw paystub reader

The app reads paystub PDFs itself. For layouts it can't read, or photos of paystubs, it can
hand the file to an OpenClaw agent you run:

1. In OpenClaw's config, turn on the OpenResponses endpoint:
   `gateway: { http: { endpoints: { responses: { enabled: true } } } }`.
2. In TrueNAS, edit the app's YAML and add (inside `finance-tracker:`):

   ```yaml
       environment:
         OPENCLAW_URL: "http://<openclaw-host>:18789"
         OPENCLAW_TOKEN: "<gateway token>"  # leave out if a trusted proxy handles auth
         # OPENCLAW_AGENT: "<agent id>"   # optional; default agent otherwise
         # If a proxy in front of OpenClaw asks for a basic login (a browser password popup):
         # OPENCLAW_USERNAME: "<proxy user>"
         # OPENCLAW_PASSWORD: "<proxy password>"
   ```

3. Save. The paystub screen then says it can fall back to your OpenClaw agent.

The paystub goes only to your own gateway, and from there to whatever model that agent
uses. Keep the gateway on your private network.

## Bank accounts from SimpleFIN

Nothing to set up in TrueNAS. After signing up, the app offers to connect
[SimpleFIN Bridge](https://beta-bridge.simplefin.org/) (or later, the bank button at the top):
make a setup token on the Bridge and paste it in. The server then pulls balances and new
transactions once every morning around 6 AM (your time when you connected), at a minute past
the hour it picks at random the first time it starts and keeps in `pb_data/simplefin_minute`.
The container needs to reach `beta-bridge.simplefin.org` over https.

If reading fails (for example "The OpenClaw agent answered with HTTP 403."), open the
PocketBase dashboard → **Logs** and click the `POST /api/paystubs/read` entry. Its
`details` show the URL called, the agent, whether a token was sent, and the gateway's
status, response headers and the start of its response body (no passwords, tokens or
cookies). A 401 or 403 with no login set usually means a proxy in front of OpenClaw is
refusing the server: the server calls `OPENCLAW_URL` directly, without your browser's
sign-in. If the proxy asks for a basic login, set `OPENCLAW_USERNAME` and
`OPENCLAW_PASSWORD`. Otherwise let the TrueNAS host through the proxy, point
`OPENCLAW_URL` at the gateway itself, or set `OPENCLAW_TOKEN`.

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
