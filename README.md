# Apollo — Marathon Training Platform

Apollo is a full-featured marathon training platform for desktop (Electron) and web (Vite + Azure Static Web Apps). Everything runs locally on your device — no cloud accounts, no data leaving your machine.

**Core capabilities:**

- **8 built-in marathon plans** from top coaches (Hal Higdon, Hanson's, Pfitzinger, Nike, FIRST) + a custom plan builder
- **Guided onboarding** with plan recommendation engine
- **Smart Strava auto-sync** — matches runs to plan days, auto-completes workouts, generates coaching feedback
- **Activity route maps** — pure SVG visualization of every run, zero external dependencies, works fully offline
- **Route effort recognition** — tracks repeated routes, awards gold/silver/bronze for pace and HR efficiency, generates data-driven insights
- **Race prediction engine** — VDOT + Riegel + pace extrapolation blend with confidence scoring
- **Weekly Race Day Readiness** — 5-factor readiness score with coaching tips
- **Adaptive training recommendations** — detects overtraining, schedule gaps, and race week, suggests plan adjustments
- **Heart rate zone analysis** — 5-zone model, zone distribution, HR trends, aerobic efficiency tracking
- **Daily training recaps** — grade + coach message comparing actual vs planned effort

---

## What's New

### Activity Route Maps
Every synced run is visualized as a pure SVG route map — no Leaflet, Mapbox, or API keys required. Works fully offline.

- **Route drawing animation** on first render
- **Start (S) / End (F) markers** with glow rings; loops detected automatically
- **Mile markers** numbered along the path
- **Compass bearing badge** with direction and loop detection (↻)
- **Three color modes**: Apollo gold, teal, Strava orange
- **Three sizes**: thumbnail (activity lists), card (expanded detail), detail (full view)
- **Hover tooltips** showing distance-at-point
- Integrated into Activities, Dashboard (Today's Quest + Recent Activities), and Training pages

### Route Effort Recognition
When you run the same route more than once, Apollo recognizes it and compares your performances with real data.

- **Route fingerprinting** — matches repeated routes by start/end location, centroid, and distance (tolerant of GPS drift)
- **Pace ranking**: gold (course record), silver (2nd fastest), bronze (3rd)
- **HR efficiency ranking**: gold/silver/bronze based on pace-to-heart-rate ratio
- **Data-driven insights** — contextual statements like:
  - *"Your pace was 7:42/mi — 4.2% faster than your last effort on this route"*
  - *"Heart rate averaged 148 bpm — 13% lower than your last effort"*
  - *"Improved efficiency — 7:42/mi at 148 bpm vs 8:03/mi at 170 bpm last time"*
  - *"Cadence was 174 spm — 14 spm higher than your route average"*
- **Automatic processing** — runs during auto-sync so history builds as you train
- Visible on Activities (detail panel + list badges), Dashboard (Today's Quest + Recent), and Training (synced day rows)

### Adaptive Training Recommendations
Apollo monitors your training patterns and surfaces intelligent recommendations when it detects something actionable.

- **5 detection scenarios**: ahead of schedule, behind schedule, overtraining/fatigue, inconsistent execution, race week optimization
- **Plan modification suggestions** with undo support (original plan snapshot preserved)
- Rate-limited by frequency setting (daily / weekly / before key workouts)
- Configurable aggressiveness: conservative / balanced / aggressive
- Safety guardrails: never increases mileage >10%, taper lock in final week

---

## Features

### 1) Guided Onboarding + Plan Selection

On first launch, runners choose from three paths:

1. **Browse popular plans** — see all 8 plans with expandable week-by-week schedules (mileage + long runs)
2. **Find my best plan** — enter current weekly mileage and running days → Apollo recommends the top 3 plans with reasons
3. **Build from scratch** — set plan name, duration (10–30 weeks), running days, current mileage, and peak mileage → Apollo generates a progressive custom plan with cutback weeks and taper

After selecting a plan and start date, a coaching setup step configures daily recaps and weekly readiness notifications.

### 2) Built-In Marathon Plans

| Plan | Author | Days/Week | Peak (~mi/wk) | Approach |
|------|--------|-----------|----------------|----------|
| Novice 1 | Hal Higdon | 4 + cross | ~45 | Most popular first-marathon plan |
| Novice 2 | Hal Higdon | 4 + cross | ~48 | Step up from Novice 1 |
| Intermediate 1 | Hal Higdon | 5 + cross | ~50 | For runners with a base |
| Advanced 1 | Hal Higdon | 5 + cross | ~57 | For PR seekers with speedwork |
| Beginner (Just Finish) | Hanson's | 6 | ~55 | Cumulative fatigue, long run capped at 16 mi |
| 18/55 | Pete Pfitzinger | 5 | ~55 | Performance-focused, marathon pace workouts |
| Marathon Plan | Nike Run Club | 5 | ~52 | Digital-first, guided speed sessions |
| Run Less, Run Faster | FIRST | 3 + 2 cross | ~40 | 3 quality runs (tempo, intervals, long) |

**Custom Plan Builder**: generates progressive plans with cutback weeks every 4th week (86%), taper (72%/45% final 2 weeks), and varied workouts.

### 3) Plan Tracking + Smart Auto-Sync

- **Week-by-week accordion checklist** with day-by-day toggles
- **Weekly mileage progress bars** (actual vs planned) per week
- **Smart Strava auto-sync** (fetches last 14 days):
  - Matches runs to plan days by date (longest run if multiple on same day)
  - Auto-completes matched workouts
  - Generates **workout-specific coaching feedback** (easy pace analysis, tempo/speed session tips, long run guidance)
  - Tracks **weekly mileage status** (on track / ahead / behind / way behind)
  - Route thumbnails appear inline on synced training days
  - Effort recognition badges (gold/silver/bronze) on synced rows

### 4) Activity Route Maps

Pure SVG route visualization for every Strava activity — no external map services or API keys:

- **Polyline decoding** (Google Encoded Polyline Algorithm) into lat/lng coordinates
- **Equirectangular projection** with latitude correction to SVG x/y points
- **Ramer-Douglas-Peucker simplification** for performance on long routes
- **Route analytics**: total distance, segments with cumulative/segment distance, compass bearing, loop detection
- **Art Deco styled visualization**: gradient paths, start/end markers with glow, mile markers, compass badge, grid pattern background
- **Local caching**: routes cached for offline access (up to 200 entries with LRU eviction)
- Displayed in **Activities** (thumbnails + detail maps), **Dashboard** (Today's Quest + Recent), and **Training** (synced day thumbnails)

### 5) Route Effort Recognition

Tracks your performance on repeated routes and provides genuine, data-driven recognition:

- **Route fingerprinting**: identifies same route across runs via start/end proximity (300m), centroid distance (500m), and total distance (±20%). Tolerant of GPS variation
- **Pace tiers**: gold (course record), silver (2nd), bronze (3rd) — only awarded when there are enough efforts to compare
- **HR efficiency tiers**: gold/silver/bronze based on pace÷heart rate ratio — recognizes when you run the same pace at lower cardiac cost
- **Contextual insights** (not generic praise):
  - **Pace**: "7:42/mi — 4.2% faster than your last effort" or "consistent with your last effort"
  - **Heart rate**: "148 bpm — 13% lower than your last effort" or "7% below your route average of 162 bpm — your cardiovascular fitness is improving"
  - **Efficiency**: "Improved efficiency — 7:42/mi at 148 bpm vs 8:03/mi at 170 bpm"
  - **Cadence**: "174 spm — 14 spm higher than your route average"
  - **Overall synthesis**: "Strong improvement — faster pace with lower heart rate" or "Your fitness is showing — similar pace at 14% lower cardiac cost"
- **Processed automatically** during auto-sync — effort history builds as you train
- All data stored locally, up to 100 route bundles with 50 efforts each

### 6) Insights + Coaching

**Race Prediction Engine**
- Blends VDOT (50%), Riegel formula (30%), and pace extrapolation (20%)
- Predicts marathon, half marathon, 10K, and 5K times
- Confidence score (0–100) based on number of synced runs, weeks completed, and HR data availability
- HR efficiency bonus: 2% time reduction when training at low HR with strong pace
- Trend tracking: improving / stable / declining

**Training Adherence Score**
- Completion rate (35%), distance adherence (25%), consistency (20%), intensity balance (20%)
- Rated excellent / good / fair / poor
- Tracks current streak, weekly scores, max gap between runs

**Weekly Race Day Readiness**
- 0–100 score with letter grade (A+ to D)
- Five sub-scores: Volume (25%), Consistency (25%), Long Run (20%), Intensity (15%), Recovery (15%)
- Auto-generated strengths, improvements, and next-week tips
- Trend detection vs previous week
- Includes current marathon prediction and days-until-race countdown

**Daily Training Recap**
- Grade: outstanding / strong / solid / missed / rest_day
- Actual distance vs planned, pace, duration, HR zone
- Workout-specific coach messages with HR zone warnings (e.g., easy day at threshold pace)
- Stores up to 365 days

**Heart Rate Zones**
- 5-zone model: Recovery, Aerobic, Tempo, Threshold, VO2 Max
- Zone distribution chart (last 30 days) with 80/20 rule coaching tip
- HR trend chart (daily avg/max over 30 days)
- Aerobic efficiency tracking (pace-to-HR ratio)
- Auto-updates max HR when higher values detected from Strava

**Adaptive Training Recommendations**
- Ahead of schedule: suggest mileage upgrade (10%) or maintain
- Behind schedule: reduce mileage (20% for 2 weeks), add recovery week (50%), or self-manage
- Overtraining/fatigue: recovery week (30% reduction) or moderate reduction (15%)
- Inconsistent execution: pacing education (easy too fast, hard too slow, gray zone warning)
- Race week: taper advice, estimated race pace, race-day strategy
- All modifications reversible with undo
- Configurable frequency and aggressiveness in Settings

### 7) Integrations

**Strava**
- OAuth2 flow for both desktop (Electron with redirect to 127.0.0.1) and web (Azure Functions token exchange)
- Fetches activities, heart rate, cadence, elevation, suffer score, route polylines
- All data stored locally after sync

**Garmin** (scaffolded)
- Client ID/Secret fields ready for Garmin developer credentials
- Full integration ready to build on existing infrastructure

---

## How to Use Apollo for Marathon Training

### Getting Started

1. **Launch Apollo** (desktop or web)
2. **Choose your plan**: browse the 8 built-in plans, use the recommendation engine, or build a custom plan
3. **Set your start date**: Apollo calculates your full week-by-week schedule through race day
4. **Connect Strava**: link your Strava account in Settings
5. **Configure coaching**: enable daily recaps and weekly readiness in the coaching setup

### Daily Workflow

1. **Run your planned workout** — check the Training page for today's scheduled run
2. **Record on Strava** as usual — with GPS and heart rate if possible
3. **Open Apollo** — the auto-sync runs automatically on the Dashboard
4. Your run is matched to today's plan day, workout is auto-completed, and you see:
   - **Route map** of your run
   - **Coaching feedback** (distance analysis, pace tips)
   - **Effort recognition** if you've run this route before (pace/HR rankings, data-driven insights)
   - **Daily recap** with grade and coach message

### Weekly Check-In

- Review your **Weekly Readiness Score** on the Insights page — see where you're strong and what to improve
- Check your **race prediction** trend — is your projected time improving?
- Look at **HR zone distribution** — are you following the 80/20 rule (most training in easy zones)?
- If Apollo surfaces an **adaptive recommendation**, review and accept/dismiss

### Building to Race Day

- **Track repeat routes** — as you run the same loops, Apollo builds your effort history and you'll start seeing gold/silver/bronze for your best performances
- **Monitor adherence** — stay above 85% for best results
- **Watch your readiness grade** climb week by week
- **Trust the taper** — Apollo adjusts recommendations in race week
- On race day, check your **estimated marathon time** (refined over your entire training block)

---

## Setup

### Desktop (Electron)

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

### Web (Browser)

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

### Running Tests

```bash
npm test
```

219 tests across 8 test files covering:
- Plan library, custom plan builder, recommendation engine
- Auto-sync matching, feedback generation, effort processing pipeline
- Route service (polyline decoding, projection, haversine, bearing, caching, formatting)
- Effort recognition (fingerprinting, matching, tier ranking, insight generation, persistence)
- Race prediction (VDOT, Riegel, blending, confidence)
- Weekly readiness scoring
- Adaptive training detection
- Storage layer

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

- **Frontend:** React 18, TypeScript 5, Vite 7, React Router
- **Desktop shell:** Electron 40
- **Web backend:** Azure Functions (Node)
- **Integrations:** Strava API v3 OAuth2
- **Persistence:** localStorage + IndexedDB (via Dexie) — all data stored locally on device
- **Route visualization:** Pure SVG (zero external map dependencies)
- **Testing:** Vitest (219 tests)
- **Design system:** Art Deco — dark navy (#0D1B2A) + gold (#D4A537), Montserrat / Inter / JetBrains Mono

## Project Structure

```
src/
  pages/           Dashboard, Training, Activities, Insights, Settings, Welcome flow
  components/      RouteMap (SVG), AdaptiveRecommendations, ErrorBoundary, LoadingScreen
  data/plans.ts    Built-in plan library, custom plan generator, recommendation engine
  services/
    autoSync.ts         Smart Strava sync + effort processing pipeline
    routeService.ts     Polyline decoding, projection, route analytics, caching
    effortService.ts    Route fingerprinting, effort ranking, insight generation
    analyticsService.ts Training adherence + analytics aggregation
    racePrediction.ts   VDOT/Riegel/pace prediction blend
    weeklyReadiness.ts  5-factor readiness scoring
    adaptiveTraining.ts Training pattern detection + recommendations
    dailyRecap.ts       Daily grade + coach messaging
    heartRate.ts        HR zones, distribution, trends, efficiency
    coachingPreferences.ts  User coaching settings
    strava.ts           Strava API client
    garmin.ts           Garmin API scaffolding
    storage.ts          Cross-platform storage utilities
    dataManager.ts      Import/export
    db/
      apolloDB.ts       Dexie database schema
      persistence.ts    Unified persistence layer (localStorage + IndexedDB)
  styles/
    design-system.css   Full Art Deco design system (CSS custom properties)
  types/
    recommendations.ts  Adaptive recommendation types
  hooks/
    useAdaptiveRecommendations.ts  React hook for recommendation UI
  __tests__/        219 tests across 8 test files
electron/           Electron main + preload
api/                Azure Functions (Strava token exchange)
public/             Static assets + SWA config
```
