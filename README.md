# Apollo — Marathon Training

An **all-in-one** marathon training app: **popular plans** (Hal Higdon, Hanson's, FIRST), **day-by-day checklist**, and **Strava** & **Garmin Connect**. Runs as a **desktop app** (Electron) or **web app** (deploy to Azure Static Web Apps).

## Features

- **Popular plans**: Hal Higdon (Novice 1 & 2, Intermediate 1, Advanced 1), Hanson's Beginner, FIRST Run Less Run Faster. Full week-by-week overview before you choose; then a day-by-day checklist.
- **First-boot welcome**: On first run you’re asked whether to pick a plan; you get a full plan overview before selecting and setting your start date.
- **Day-by-day checklist**: Mark each run, cross-train, or race complete. Progress saved in the browser or app.
- **Dashboard**: Today’s workout, plan progress, Strava/Garmin status, recent activities.
- **Strava**: OAuth sign-in (desktop: you enter Client ID/Secret; web: server-side config), activities, auto token refresh.
- **Garmin**: Placeholder for when you have Garmin Connect Developer Program access.

## Setup

### Desktop (Electron)

```bash
npm install
npm run dev
```

Production build:

```bash
npm run electron:build
```

Built app is in `release/`.

**Strava (desktop):** Create an app at [Strava API Settings](https://www.strava.com/settings/api). Set Authorization Callback Domain to `127.0.0.1`. In Apollo **Settings**, enter Client ID and Secret, then **Connect Strava**.

### Web (browser)

Build the web app (no Electron):

```bash
npm run build:web
```

Preview locally (static only; no API):

```bash
npm run preview:web
```

To run the full stack locally (app + API):

```bash
npm run build:web
npm install -g @azure/static-web-apps-cli
cd api && npm install && cd ..
npm run swa
```

Then open `http://localhost:4280`. Set `api/local.settings.json` with `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, and `BASE_URL` (e.g. `http://localhost:4280`).

---

## Deploy to Microsoft Azure (Static Web Apps)

Apollo is set up to deploy as an **Azure Static Web App**: static frontend + serverless API (Strava OAuth).

### 1. Strava app (for web)

1. Go to [Strava API Settings](https://www.strava.com/settings/api) and create an application.
2. Set **Authorization Callback Domain** to your Azure site’s host **without** `https://` or path, e.g. `your-app-name.azurestaticapps.net`.
3. Note your **Client ID** and **Client Secret**.

### 2. Create the Static Web App in Azure

1. In [Azure Portal](https://portal.azure.com), create a resource **Static Web App**.
2. Connect your **GitHub** repo and branch (e.g. `main`).
3. Configure the build:
   - **Build Presets:** Custom.
   - **App location:** `/`
   - **Output location:** `dist`
   - **Api location:** `api`
   - **App build command:** `npm ci && npm run build:web`
4. Create the resource. Azure will add a GitHub Action and a **deployment token** (secret).

### 3. GitHub secret

- In your repo: **Settings → Secrets and variables → Actions**.
- Add a secret: `AZURE_STATIC_WEB_APPS_API_TOKEN` with the deployment token from the Static Web App (Overview → Manage deployment token).

### 4. Application settings (Strava + base URL)

In Azure Portal → your Static Web App → **Configuration** → **Application settings**, add:

| Name | Value |
|------|--------|
| `STRAVA_CLIENT_ID` | Your Strava Client ID |
| `STRAVA_CLIENT_SECRET` | Your Strava Client Secret |
| `BASE_URL` | Your site URL, e.g. `https://your-app-name.azurestaticapps.net` |

Save. The API uses these for OAuth redirect and token exchange.

### 5. Deploy

Push to `main` (or open a PR). The GitHub Action will build and deploy. After the first successful run, your site is live at `https://<name>.azurestaticapps.net`.

### Workflow file

The workflow is in `.github/workflows/azure-static-web-apps.yml`. You can change the branch or build command there if needed.

---

## Tech stack

- **Frontend:** Vite, React, React Router.
- **Desktop:** Electron (OAuth callback server, IPC).
- **Web API:** Azure Functions (Node) in `/api` for Strava auth URL, token exchange, and refresh.
- **Strava:** API v3; OAuth 2.0; tokens stored in the client (localStorage).

## Project structure

- `src/` – React app (Dashboard, Training, Activities, Settings, Welcome, Auth callback, 404).
- `src/services/` – Strava client (Electron or web API), storage, plan progress.
- `src/data/plans.ts` – Built-in plans (Hal Higdon, Hanson's, FIRST).
- `electron/` – Desktop main process and preload (only used for Electron build).
- `api/` – Azure Functions for web: Strava OAuth (auth URL, exchange, refresh).
- `public/` – Static assets, `manifest.json`, `staticwebapp.config.json` (SPA + security headers).
