# Apollo — Marathon Training Platform

Apollo is a marathon training app for desktop (Electron) and web (Vite + Azure Static Web Apps) with:

- a **large library of popular marathon plans**,
- **first-launch guided plan selection**,
- **custom plan generation from scratch**,
- **smart Strava auto-sync** into your plan,
- and **insights/coaching tools** (prediction, readiness, recaps, HR zones).

## What's New

- Added more popular plans, including **Pete Pfitzinger 18/55**.
- Added first-launch **3-path onboarding**:
  1. Browse popular plans,
  2. Use the **plan recommendation tool**,
  3. **Build a custom plan from scratch**.
- Added recommendation scoring based on **weekly miles + running days**.
- Expanded coaching/insights with race prediction, weekly readiness, and daily recaps.

## Features

### 1) Plan Library + First-Launch Plan Selection

On first app launch, runners can choose one of three clearly separated options:

1. **Browse popular plans**
   - Expand each plan to view week-by-week mileage + long runs before choosing.
2. **Find my best plan (recommendation tool)**
   - Enter current weekly mileage and run days/week.
   - Apollo returns top-fit plans with reasons.
3. **Build from scratch (custom plan builder)**
   - Set plan name, duration, running days, current weekly mileage, and peak weekly mileage.
   - Apollo generates and saves a progressive custom marathon plan.

### 2) Built-In Marathon Plans

Current built-in plan catalog:

- **Hal Higdon**
  - Novice 1
  - Novice 2
  - Intermediate 1
  - Advanced 1
- **Hanson's**
  - Beginner (Just Finish)
- **Pete Pfitzinger**
  - **18/55**
- **Nike Run Club**
  - Marathon Plan
- **FIRST**
  - Run Less, Run Faster

### 3) Plan Tracking + Smart Auto-Sync

- Day-by-day training checklist with completion persistence.
- Smart Strava auto-sync that can:
  - match runs to plan days,
  - auto-complete matched workouts,
  - attach pace/distance/time feedback,
  - track weekly mileage progress.

### 4) Insights + Coaching

- **Race Prediction Engine** (VDOT + extrapolation blend)
- **Training Adherence Score**
- **Weekly Race Day Readiness** recap + trend
- **Daily Training Recap** with plan-vs-actual analysis
- **Heart Rate Zones** (5-zone model), zone distribution, HR trend

### 5) Integrations

- **Strava OAuth** (desktop + web flows)
- **Garmin support scaffolding** (ready for full Garmin developer credentials flow)

## Setup

## Desktop (Electron)

```bash
npm install
npm run dev
```

Create production installer:

```bash
npm run electron:build
```

Output is written to `release/`.

**Strava (desktop):**
1. Create an app at [Strava API Settings](https://www.strava.com/settings/api)
2. Set Authorization Callback Domain to `127.0.0.1`
3. In Apollo **Settings**, enter Client ID and Client Secret
4. Click **Connect Strava**

## Web (Browser)

Build frontend only:

```bash
npm run build:web
```

Preview static build locally:

```bash
npm run preview:web
```

Run full local stack (frontend + API):

```bash
npm run build:web
npm install -g @azure/static-web-apps-cli
npm --prefix api install
npm run swa
```

Then open `http://localhost:4280`.

Create `api/local.settings.json` with:

- `STRAVA_CLIENT_ID`
- `STRAVA_CLIENT_SECRET`
- `BASE_URL` (for example `http://localhost:4280`)

---

## Deploy to Azure Static Web Apps

Apollo is configured for Azure Static Web Apps (SPA frontend + Azure Functions API).

### 1) Create Strava App (Web)

1. Go to [Strava API Settings](https://www.strava.com/settings/api)
2. Create an app
3. Set callback domain to your site hostname only (no protocol/path), e.g. `your-app.azurestaticapps.net`
4. Save Client ID + Client Secret

### 2) Create Static Web App in Azure

In Azure Portal:

- Create **Static Web App**
- Connect this GitHub repo + branch
- Build settings:
  - App location: `/`
  - Output location: `dist`
  - API location: `api`
  - App build command: `npm ci && npm run build:web`

### 3) Add GitHub Secret

Add repository secret:

- `AZURE_STATIC_WEB_APPS_API_TOKEN`

### 4) Add Azure App Settings

| Name | Value |
|------|-------|
| `STRAVA_CLIENT_ID` | Strava Client ID |
| `STRAVA_CLIENT_SECRET` | Strava Client Secret |
| `BASE_URL` | `https://<your-app>.azurestaticapps.net` |

### 5) Deploy

Push to your deployment branch and GitHub Actions will build/deploy.

Workflow file: `.github/workflows/azure-static-web-apps.yml`

---

## Tech Stack

- **Frontend:** React, TypeScript, Vite, React Router
- **Desktop shell:** Electron
- **Web backend:** Azure Functions (Node)
- **Integrations:** Strava API v3 OAuth2
- **Persistence:** localStorage (plan state, sync meta, insights/coaching data)

## Project Structure

- `src/pages/` — Dashboard, Training, Activities, Insights, Settings, Welcome flow
- `src/data/plans.ts` — built-in plans, custom plan generator, recommendation tool
- `src/services/` — auto-sync, progress persistence, prediction/readiness/recap/HR/coaching services
- `electron/` — Electron main + preload
- `api/` — Azure Functions endpoints for web auth/token exchange
- `public/` — static assets and SWA config
