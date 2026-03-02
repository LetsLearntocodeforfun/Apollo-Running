<p align="center">
  <img src="public/assets/logo-1024.png" alt="Apollo" width="140" />
</p>

<h1 align="center">Apollo</h1>

<p align="center">
  <strong>The all-in-one marathon training platform.</strong><br />
  Smart plans · Strava sync · Route maps · Race predictions · Coaching intelligence<br />
  <em>100% local. Zero cloud accounts. Your data never leaves your device.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tests-360%20passing-brightgreen" alt="360 tests passing" />
  <img src="https://img.shields.io/badge/typescript-strict-blue" alt="TypeScript strict" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
  <img src="https://img.shields.io/badge/platform-desktop%20%7C%20web-gold" alt="Desktop & Web" />
</p>

---

## Table of Contents

- [Why Apollo](#why-apollo)
- [Quick Start](#quick-start)
- [Features at a Glance](#features-at-a-glance)
- [The Training Calendar](#the-training-calendar)
- [How the App Works — Page by Page](#how-the-app-works--page-by-page)
  - [Dashboard](#-dashboard)
  - [Training Plan](#-training-plan)
  - [Activities](#-activities)
  - [Analytics](#-analytics)
  - [Insights](#-insights)
  - [Race Strategy](#-race-strategy)
  - [Settings](#-settings)
- [Guided Onboarding](#guided-onboarding)
- [Built-In Marathon Plans](#built-in-marathon-plans)
- [Smart Auto-Sync](#smart-auto-sync)
- [Route Maps](#route-maps)
- [Route Effort Recognition](#route-effort-recognition)
- [Split & Lap Analysis](#split--lap-analysis)
- [Race Prediction Engine](#race-prediction-engine)
- [Coaching Intelligence](#coaching-intelligence)
- [Race Strategy](#race-strategy)
  - [World Marathon Majors Database](#world-marathon-majors-database)
  - [Strategy Builder](#strategy-builder)
  - [Custom Marathon Import](#custom-marathon-import)
- [Data Safety & Backups](#data-safety--backups)
- [Integrations](#integrations)
- [Your Training Playbook](#your-training-playbook)
- [Setup & Installation](#setup--installation)
- [Deploy to Azure Static Web Apps](#deploy-to-azure-static-web-apps)
- [Running Tests](#running-tests)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [License](#license)

---

## Why Apollo

Most running apps fall into two camps: simple trackers that tell you what you already know, or complex platforms buried behind paywalls and subscription tiers.

Apollo is different. It combines the depth of a professional coaching platform with the simplicity of a personal training log — and it runs entirely on your machine. No subscriptions. No data harvesting. No internet required after your initial Strava sync.

What sets Apollo apart:

- **Plans from the coaches who wrote the book** — Hal Higdon, Hanson's, Pfitzinger, Nike Run Club, and FIRST. Or build your own from scratch.
- **Intelligence that earns its name** — Race predictions refined across your entire training block. Adaptive recommendations that detect overtraining before you feel it. Pacing analysis that holds you accountable to the 80/20 rule.
- **Every run tells a richer story** — Route maps rendered as Art Deco artwork. Split-level pacing breakdowns. Effort recognition that remembers every time you've run that neighborhood loop and tells you exactly how today compared.
- **Your data, your device** — localStorage + IndexedDB. Automatic backups with SHA-256 integrity verification. Export everything as JSON. Nothing leaves your machine.

---

## Quick Start

```bash
git clone https://github.com/LetsLearntocodeforfun/Apollo-Running.git
cd Apollo-Running
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser. Apollo's guided onboarding will walk you through choosing a plan, setting your start date, picking your preferred units, and configuring coaching preferences.

To connect Strava, see [Integrations](#integrations).

---

## Features at a Glance

| Feature | What It Does |
|---------|-------------|
| **8 marathon plans** | Hal Higdon (4), Hanson's, Pfitzinger, Nike, FIRST — plus a custom plan builder |
| **Training calendar** | Monthly grid with workout types, intensity colors, sync status, click-to-expand day detail |
| **Smart auto-sync** | Matches Strava runs to plan days, auto-completes workouts, generates coaching feedback |
| **Route maps** | Pure SVG visualization of every run — offline, no API keys, with animated drawing effects |
| **Effort recognition** | Tracks repeated routes, awards Gold/Silver/Bronze for pace and HR efficiency |
| **Split analysis** | Per-mile/km pacing charts, consistency grading, interval detection, pattern recognition |
| **Race predictions** | VDOT + Riegel blend for marathon, half, 10K, and 5K with confidence scoring |
| **Weekly readiness** | 5-factor score (A+ to D) with coaching tips for the week ahead |
| **Daily recaps** | Grade + coach message comparing your actual effort to the plan |
| **Adaptive coaching** | Detects overtraining, schedule gaps, and race week — suggests plan adjustments |
| **HR zone analysis** | 5-zone model, distribution charts, efficiency tracking, 80/20 rule guidance |
| **Data backups** | Automatic SHA-256 verified backups with export/import and one-click restore |
| **Race strategy** | Grade-adjusted pacing plans for World Majors + custom marathons, elevation charts, nutrition planning |
| **Auto-sync on launch** | Opt-in automatic Strava sync when the app opens, with 5-minute cooldown |
| **Auto-updates** | Opt-in update checking, downloading, and installing (Electron desktop) |
| **Miles & kilometers** | One toggle changes every number in the entire app |

---

## The Training Calendar

The crown jewel of the Training page. A full monthly calendar view that shows your entire training block at a glance — designed to rival and surpass what you'd find in TrainingPeaks or Strava.

**At the grid level:**
- Each day cell shows the **workout type** with color-coded intensity bars (green = easy, gold = long run, orange = tempo, red = speed, teal = cross training)
- **Workout icons** indicate the session type (🟢 Easy · 🟡 Long · 🟠 Tempo · 🔴 Speed · 🏁 Race · 🏅 Marathon)
- **Distance** displayed per day — with actual/planned shown side-by-side when a Strava activity is synced
- **Mini progress bars** visualize how close your actual distance came to the plan target
- **Completion badges** — gold ✓ for Strava-synced days, green ✓ for manually completed
- Today is highlighted with a gold ring and filled badge so you never lose your place

**Weekly summary column:**
- Plan week number, actual vs planned total mileage, and a progress bar — visible alongside every row

**Click any day to expand the detail panel:**
- **Plan vs Actual** side-by-side comparison — workout type, distance, pace, duration, and a ± delta showing exactly how you tracked against the plan
- **Full route map** of the synced activity (animated, with mile markers and compass badge)
- **Effort recognition** tier badge (Gold/Silver/Bronze) when you've run this route before
- **Coaching feedback** — the AI-generated message from auto-sync
- **Mark Complete / Incomplete** button for manual tracking

**Navigation:**
- Month-by-month browsing with ‹ › arrows
- **Today** button for instant jump to the current date
- **Calendar ↔ Checklist** toggle to switch between the visual calendar and the traditional week-by-week accordion

Everything updates live — complete a day, sync a run, and the calendar reflects it immediately.

---

## How the App Works — Page by Page

### ◈ Dashboard

Your home base. Everything you need in one view.

- **Personalized greeting** with your Strava athlete name and connection status
- **Today's Quest** — a hero card showing today's planned workout, with distance, type, and (once synced) your actual metrics, coaching feedback, route map, and effort recognition
- **Plan progress bar** — percentage complete with days-completed count
- **Stats strip** — race prediction, training adherence, and readiness grade at a glance
- **Adaptive recommendations** — intelligent coaching cards when Apollo detects something actionable (overtraining, schedule gap, race week)
- **Daily recap** — pop-up card with your training grade and coach message
- **Weekly readiness** — pop-up with your composite score, strengths, and tips for the week ahead
- **Recent activities** — your last five runs with route thumbnails, distance, pace, and effort tier indicators

Auto-sync triggers on load when Strava is connected and a plan is active. No manual action needed.

### ⚡ Training Plan

Where your plan lives.

- **Plan selection** — browse all eight built-in plans displayed as cards, or access the custom plan builder through the Welcome Flow
- **Calendar view** *(new)* — the monthly training calendar described above
- **Checklist view** — the traditional week-by-week accordion with expandable day rows showing checkboxes, dates, workout labels, sync badges, tier badges, route thumbnails, and detailed metrics
- **Weekly mileage bars** — per-week actual vs planned with color-coded status (on track / ahead / behind)
- **Smart Auto-Sync card** — manual sync trigger, last sync timestamp, and detailed results for every matched activity

### 🏅 Activities

Your complete run history.

- **Paginated activity list** — 30 per page, each row showing route thumbnail, activity name with tier dot, date, distance, duration, pace, elevation, and heart rate
- **Expandable detail panel** (click any activity):
  - Full-size route map with animation, mile markers, and compass
  - Stats grid: distance, duration, pace, elevation, HR (avg + max), cadence, route type, suffer score
  - **Split analysis** — tabbed view with pace bar chart, per-split table, per-lap table, consistency grade, pattern detection, interval detection, and coaching insights
  - **Effort recognition** — effort count, route name, pace and HR efficiency tiers, and data-driven insight messages

### 📈 Analytics

Deep dive into your training data.

- **Time period selector** — 7 days, 30 days, 90 days, 6 months, or all time
- **Summary stats** with period-over-period deltas — total miles, time, average pace, run count, average HR, elevation
- **Week-over-week comparison** — this week vs last across key metrics
- **Charts** (powered by Recharts):
  - Weekly mileage bar chart
  - Pace progression line chart (average + fastest per week)
  - Training load area chart — acute (7-day) vs chronic (28-day) with optimal ratio guidance
  - HR efficiency scatter plot — pace vs heart rate with trend highlighting
- **Consistency heatmap** — GitHub-style contribution grid showing your training frequency over 90 days, with streak counts
- **Personal records** — fastest pace, longest run, and more, with activity names and dates

### 📊 Insights

Your coaching intelligence hub, organized into four tabs.

**Overview** — Race prediction with marathon, half, 10K, and 5K times. VDOT score and confidence percentage. Score gauges for adherence, readiness, distance match, and consistency. Detailed adherence and readiness breakdowns with strengths, improvements, and tips. Today's training recap. Readiness history across weeks.

**Heart Rate Zones** — Editable HR profile (max HR, resting HR, LTHR). Five-zone definitions with BPM ranges. Zone distribution chart (last 30 days) with 80/20 rule coaching. HR trend chart showing daily average across activities.

**Daily Recaps** — Today's detailed recap with grade, distance comparison (± percentage vs plan), pace, duration, HR zone, and coach message. Scrollable history of the past seven days.

**Coaching Settings** — Toggle daily recaps on/off with time-of-day scheduling. Toggle weekly readiness on/off with day-of-week picker. Methodology explanations for VDOT, Riegel, adherence scoring, readiness factors, and HR zones.

### 🏅 Race Strategy

Plan your race with course-specific pacing, elevation-adjusted splits, and nutrition timing.

- **Opt-in activation** — hero card explaining the feature with an "Enable Race Strategy" button; can also be enabled during onboarding
- **Marathon browser** — browse all six World Marathon Majors plus any custom-imported marathons with filtering, search, and expandable course details
- **Strategy builder** — enter your target finish time, choose a pacing strategy (negative-split, even-split, positive-split, or effort-based), and Apollo generates a mile-by-mile plan adjusted for elevation
- **Elevation charts** — interactive SVG elevation profiles with landmark labels and mile highlighting
- **My Strategies** — view, compare, and manage all saved strategies
- **Custom marathon import** — add any marathon with name, city, date, elevation, temperature, and notes
- **Nutrition planning** — auto-generated gel and hydration timing based on aid station locations

See [Race Strategy](#race-strategy) for the full deep-dive.

### ⚙ Settings

Configuration and data management.

- **Strava connection** — one-click OAuth on web; Client ID + Secret fields on desktop
- **Garmin Connect** — credential fields ready for integration
- **Distance units** — miles or kilometers, one toggle that changes everything app-wide
- **Auto-sync on launch** — opt-in automatic Strava sync every time the app opens (5-minute cooldown prevents redundant syncs)
- **Auto-updates (Electron)** — opt-in update checking with granular controls: auto-check, auto-download, manual check button, download/install buttons with real-time progress bar, and version display
- **Coaching preferences** — daily recap scheduling, weekly readiness scheduling, HR profile inputs
- **Adaptive training** — enable/disable, frequency (daily / weekly / before key workouts), aggressiveness (conservative / balanced / aggressive)
- **Race strategy** — enable/disable the race strategy feature
- **Data management** — backup health status, auto-backup configuration (interval + retention), manual backup, export/import as JSON, backup history with integrity verification, per-backup download and restore

---

## Guided Onboarding

On first launch, Apollo walks you through a nine-step setup:

1. **Choose your path** — browse plans, get a recommendation, or build from scratch
2. **Get recommended** *(if selected)* — enter your weekly mileage and running days; Apollo scores and ranks the top three plans with reasons
3. **Browse all plans** *(if selected)* — expandable week-by-week previews with total and long-run mileage
4. **Build custom** *(if selected)* — set name, weeks (10–30), running days (3–6), current and peak mileage; Apollo generates a progressive plan with cutback weeks and taper
5. **Set your start date** — Apollo calculates the full schedule through race day
6. **Pick your units** — miles (🇺🇸) or kilometers (🌍) with visual selection buttons
7. **Race strategy** *(optional)* — opt in to the race strategy feature for course-specific pacing plans with World Majors data and custom marathon imports
8. **Configure coaching** — daily recaps and weekly readiness scheduling
9. **Complete** — ready to train

You're running in under two minutes.

---

## Built-In Marathon Plans

Eight proven plans from the coaches who defined the discipline.

| Plan | Author | Days/Week | Peak (~mi/wk) | Philosophy |
|------|--------|-----------|----------------|------------|
| Novice 1 | Hal Higdon | 4 + cross | ~45 | The most popular first-marathon plan in the world |
| Novice 2 | Hal Higdon | 4 + cross | ~48 | One step up — slightly more volume, same structure |
| Intermediate 1 | Hal Higdon | 5 + cross | ~50 | For runners with a solid base who want more |
| Advanced 1 | Hal Higdon | 5 + cross | ~57 | PR-focused with dedicated speedwork sessions |
| Beginner | Hanson's | 6 | ~55 | Cumulative fatigue philosophy — long run capped at 16 mi |
| 18/55 | Pete Pfitzinger | 5 | ~55 | Performance-focused with marathon-pace workouts |
| Marathon Plan | Nike Run Club | 5 | ~52 | Modern digital-first design with guided speed sessions |
| Run Less, Run Faster | FIRST | 3 + 2 cross | ~40 | Three quality runs per week (tempo, intervals, long) |

**Custom Plan Builder** generates progressive plans with cutback weeks every 4th week (86% volume), a two-week taper (72% then 45%), and varied workout types (easy, long, tempo, speed, cross training). Mileage builds from your current weekly volume to your target peak.

---

## Smart Auto-Sync

Connect Strava once and Apollo handles the rest.

**How it works:**
1. Apollo fetches your last 14 days of Strava activities
2. Each run is matched to a plan day by date (if multiple runs on the same day, the longest one is used)
3. Matched workouts are auto-completed
4. For each match, Apollo generates **coaching feedback** — distance analysis against the target, pace commentary tailored to the workout type (easy, tempo, speed, long), and weekly mileage status

**After every sync, Apollo also:**
- Captures heart rate data for zone analysis and efficiency tracking
- Processes route effort recognitions (repeated route detection + tier ranking)
- Updates race predictions with the latest data
- Recalculates training adherence and weekly readiness
- Generates daily recap and adaptive recommendations if due

All of this happens automatically when you open the Dashboard or Training page.

---

## Route Maps

Every synced run is rendered as a pure SVG route visualization. No Leaflet. No Mapbox. No API keys. Works fully offline.

- **Polyline decoding** — Strava's encoded polyline is decoded into coordinates
- **Equirectangular projection** with latitude correction — coordinates mapped to SVG points
- **Ramer-Douglas-Peucker simplification** — long routes stay performant
- **Animated route drawing** — the path "draws itself" on first render
- **Start (S) and Finish (F) markers** with glow rings; **loop detection** shown automatically
- **Mile markers** numbered along the path
- **Compass badge** showing route bearing direction
- **Three sizes** — thumbnail (activity lists), card (expanded panels), detail (full view)
- **Hover tooltips** — distance at any point along the route
- **Art Deco styling** — gold gradients, grid pattern background, corner accents, three color modes (Apollo gold, teal, Strava orange)
- **Offline caching** — up to 200 routes cached locally with LRU eviction

Visible throughout the app: Activities, Dashboard, Training Calendar, and the expanded detail panels.

---

## Route Effort Recognition

Run the same route twice and Apollo starts building your performance history.

**How routes are matched:**
Routes are fingerprinted by start/end proximity (300m tolerance), centroid distance (500m), and total distance (±20%). This is deliberately tolerant of GPS drift — if you run the same neighborhood loop but start from a different corner, Apollo still recognizes it.

**What you earn:**
- 🥇 **Gold** — your course record (fastest pace)
- 🥈 **Silver** — second fastest
- 🥉 **Bronze** — third fastest
- Separate tiers for **HR efficiency** (pace-to-heart-rate ratio) — recognizes when you run the same pace at lower cardiac cost

**What you learn:**
Apollo generates contextual insights based on real data, not generic encouragement:

> *"Your pace was 7:42/mi — 4.2% faster than your last effort on this route."*
>
> *"Heart rate averaged 148 bpm — 13% lower than last time. Your cardiovascular fitness is improving."*
>
> *"Improved efficiency — 7:42/mi at 148 bpm vs 8:03/mi at 170 bpm last time."*
>
> *"Cadence was 174 spm — 14 spm higher than your route average."*
>
> *"Strong improvement — faster pace with lower heart rate."*

Effort history builds automatically during every auto-sync. Up to 100 route bundles, 50 efforts each — stored locally, always available.

---

## Split & Lap Analysis

Every activity with split data gets a detailed pacing breakdown.

**Pace bar chart** — a pure SVG visualization showing pace per split with color-coded bars (fastest, slowest, faster/slower than mean, near mean). Includes a mean pace reference line and optional HR overlay dots.

**Consistency grading:**
- 🥇 Gold — CV < 4% (metronomic pacing)
- 🥈 Silver — CV 4–7% (strong consistency)
- 🥉 Bronze — CV 7–12% (moderate variation)
- 🔩 Iron — CV ≥ 12% (significant variation)

**Pattern detection:** negative split, positive split, even, fade (slowing in final quarter), surge, variable.

**Interval recognition:** detects alternating fast/slow lap patterns with work × rest count and ratio — so tempo runs and speed sessions are analyzed differently from steady-state efforts.

**Coaching insights** with sentiment coloring — pacing consistency commentary, split pattern analysis, HR drift detection, and progression observations.

---

## Race Prediction Engine

Apollo blends three established models to predict your race times:

| Model | Weight | Method |
|-------|--------|--------|
| VDOT | 50% | Jack Daniels' VO2max-equivalent tables |
| Riegel | 30% | Pete Riegel's time-distance formula (exponent 1.06) |
| Pace Extrapolation | 20% | Direct pace projection from recent training |

**Predictions for:** Marathon · Half Marathon · 10K · 5K

**Confidence score** (0–100) based on:
- Number of synced runs (more data = higher confidence)
- Weeks of plan completed
- Availability of heart rate data
- HR efficiency bonus: 2% time improvement when training shows strong pace at low cardiac cost

**Trend tracking:** improving, stable, or declining — so you can see whether your predicted marathon time is moving in the right direction week over week.

---

## Coaching Intelligence

### Daily Training Recaps

After each training day, Apollo grades your effort and delivers a focused coach message.

**Grades:** Outstanding · Strong · Solid · Missed · Rest Day

Each recap includes actual distance vs planned (with ± percentage), pace, duration, HR zone, and a workout-specific message. If you ran an easy day at threshold pace, Apollo will flag it. If you crushed a long run, Apollo acknowledges it. Up to 365 days of recap history.

### Weekly Race Day Readiness

A composite 0–100 score with a letter grade (A+ through D), built from five weighted factors:

| Factor | Weight | What It Measures |
|--------|--------|-----------------|
| Volume | 25% | Weekly mileage vs plan target |
| Consistency | 25% | Run frequency and gap analysis |
| Long Run | 20% | Longest run completion and distance |
| Intensity | 15% | Workout type distribution |
| Recovery | 15% | Rest day compliance and easy run pacing |

Includes: auto-generated strengths and areas to improve, actionable tips for the following week, trend vs previous week, and a days-until-race countdown.

### Adaptive Training Recommendations

Apollo monitors five training scenarios and surfaces recommendations when action is needed:

| Scenario | Example Recommendation |
|----------|----------------------|
| **Ahead of schedule** | Suggest a 10% mileage increase or maintain current pace |
| **Behind schedule** | Reduce mileage 20% for two weeks, or add a recovery week at 50% |
| **Overtraining / fatigue** | Full recovery week (30% reduction) or moderate pullback (15%) |
| **Inconsistent execution** | Pacing education — easy runs too fast, hard runs too slow, gray zone warnings |
| **Race week** | Taper advice, estimated race pace, and race-day strategy |

All plan modifications are **reversible** — Apollo snapshots the original plan before making changes, and every recommendation includes an undo option. Safety guardrails prevent mileage increases above 10% and lock taper in the final week.

Configurable in Settings: frequency (daily / weekly / before key workouts) and aggressiveness (conservative / balanced / aggressive).

---

## Race Strategy

Apollo's Race Strategy feature lets you build course-specific pacing plans with grade-adjusted splits, elevation visualization, and nutrition timing — for any of the six World Marathon Majors or any custom marathon you import.

### World Marathon Majors Database

Six complete course profiles, built from real race data:

| Marathon | Date (2026) | Course | Difficulty | Notes |
|----------|-------------|--------|:----------:|-------|
| **Tokyo** | March 1 | Point-to-point | 3/10 | Flattest major. Ideal for a PR. |
| **Boston** | April 20 | Point-to-point | 8/10 | Net downhill but deceptive — Heartbreak Hill at mile 20. |
| **London** | April 26 | Loop | 3/10 | Flat and fast along the Thames. |
| **Berlin** | September 27 | Loop | 2/10 | THE fastest course. Multiple world records. |
| **Chicago** | October 11 | Loop | 3/10 | Flat tour of 29 neighborhoods. |
| **New York City** | November 1 | Point-to-point | 9/10 | Five boroughs, five bridges. The hardest major. |

**Each course includes:**
- **Elevation profile** — 15+ data points with named landmarks (e.g., Heartbreak Hill, Queensboro Bridge)
- **Mile-by-mile splits** — terrain classification and landmark notes per segment
- **Aid stations** — locations, names, and offerings (water, electrolyte, gel)
- **Race tips** — 8–12 course-specific tips (e.g., "Bank time on the Newton downhills before Heartbreak Hill")
- **Environmental data** — typical temperature range, humidity, and field size
- **Qualifying info** — entry requirements, lottery odds, charity options
- **Time limits** — official cutoff in hours
- **PR-friendly / BQ-friendly badges** — at-a-glance course suitability

### Strategy Builder

Select a marathon → enter your target finish time → choose a pacing strategy → Apollo generates a complete race plan.

**Four pacing strategies:**

| Strategy | How It Works |
|----------|-------------|
| **Negative Split** | Start conservatively, finish strong — second half faster than the first |
| **Even Split** | Consistent pace throughout, adjusted only for elevation |
| **Positive Split** | Faster early pace, banking time for a slower finish |
| **Effort-Based** | Maintains consistent effort rather than consistent pace — uphill slows, downhill quickens naturally |

**What Apollo calculates per mile:**
- **Target pace** — adjusted for that mile's elevation gain/loss (uphill slower, downhill faster with quad-protection limits)
- **Cumulative time** — running total so you can check your watch at every mile marker
- **Elevation change** — gain or loss for the mile with directional indicators
- **Notes** — landmarks, terrain callouts, and pacing advice

**Strategy summary includes:**
- Target finish time and average pace
- First half / second half split times and the difference between them
- Interactive elevation chart with pace overlay
- Full mile-by-mile pace table
- Nutrition plan with gel and hydration timing

### Custom Marathon Import

Running a race that isn't a World Major? Import it.

- **Required fields:** name, city, country, date
- **Optional fields:** distance, course type (loop, point-to-point, out-and-back), elevation gain, temperature range, website URL, notes
- Custom marathons appear alongside World Majors in the marathon browser
- Build strategies for custom races the same way — pacing adjustments use whatever elevation data you provide
- Deleting a custom marathon cascades to remove all its associated strategies

### Nutrition Planning

Every strategy includes an auto-generated nutrition plan:

- **Gel timing** — approximately every 5 miles, coordinated with aid station positions
- **Hydration** — water and electrolyte intake at aid stations
- **Per-item notes** — what to take, when, and why

### Heart Rate Zone Analysis

Standard five-zone model:

| Zone | Name | Effort |
|------|------|--------|
| 1 | Recovery | Very easy conversational pace |
| 2 | Aerobic | Comfortable pace — the engine builder |
| 3 | Tempo | Comfortably hard — lactate threshold development |
| 4 | Threshold | Hard — sustainable for ~30 minutes |
| 5 | VO2 Max | Very hard — peak oxygen uptake training |

**Zone distribution chart** (last 30 days) with 80/20 rule guidance — most training should be in Zones 1–2. **HR trend chart** showing daily averages. **Aerobic efficiency tracking** (pace-to-HR ratio over time). Auto-detects and updates max HR when Strava reports a higher value.

---

## Data Safety & Backups

Your training data is important. Apollo protects it at multiple levels.

- **Dual persistence:** every write goes to both localStorage (instant, synchronous) and IndexedDB (durable, async). If either is cleared, the other restores it automatically on next launch.
- **Automatic backups** — configurable interval (12 hours to 1 week), retention count (how many backups to keep), runs silently on app startup
- **SHA-256 integrity checksums** — every backup is verified on creation and on restore. Tampered backups are flagged immediately.
- **One-click export** — download everything as a single JSON file
- **Safe import** — file size limits (10 MB), per-key size limits (1 MB), key allowlist validation, checksum verification, and a safety backup created before any restore
- **Backup health monitoring** — Settings shows a status badge (Protected / Warning / At Risk) based on backup age and integrity
- **Backup history** — every backup listed with date, size, key count, trigger type (auto/manual), and integrity status

---

## Integrations

### Strava

Full OAuth2 integration for both platforms:

| Platform | Method |
|----------|--------|
| **Desktop (Electron)** | Enter Client ID + Client Secret in Settings → OAuth redirect to `127.0.0.1` |
| **Web** | One-click OAuth via Azure Functions token exchange |

Apollo fetches: activities, heart rate (average + max), cadence, elevation, suffer score, GPS polylines, split data (metric + standard), and lap data.

**Setup (desktop):**
1. Create an app at [Strava API Settings](https://www.strava.com/settings/api)
2. Set Authorization Callback Domain to `127.0.0.1`
3. In Apollo Settings, enter your Client ID and Client Secret
4. Click **Connect Strava**

**Setup (web):** see [Deploy to Azure Static Web Apps](#deploy-to-azure-static-web-apps).

**Rate limiting:** Apollo tracks Strava's rate limits via response headers and maintains a buffer below the 15-minute and daily caps. Token refresh is mutex-protected to prevent concurrent refresh races.

### Garmin *(scaffolded)*

Client ID and Secret fields are ready in Settings. The integration infrastructure (Activity, Health, Training, and Courses API endpoints) is stubbed and designed to build on the same patterns as the Strava integration.

---

## Your Training Playbook

A guide to getting the most out of Apollo across your training block.

### Week 1 — Getting Started

1. **Launch Apollo** and complete the onboarding — choose a plan, set your start date, pick units, configure coaching
2. **Connect Strava** in Settings
3. **Run your first planned workout** and record it on Strava as usual
4. **Open Apollo** — your run syncs automatically, your day is marked complete, and you receive your first coaching feedback

### Every Run Day

1. Check the **Training Calendar** for today's workout
2. Run and record on Strava (GPS + heart rate for the richest insights)
3. Open Apollo — auto-sync fires on the Dashboard. You'll see your route map, coaching feedback, and (once you have repeat routes) effort recognition

### Every Week

- Review **Weekly Readiness** on the Insights page — identify strengths and areas to improve
- Check your **race prediction** trend — is your projected time getting faster?
- Look at **HR zone distribution** — are you following the 80/20 rule?
- If Apollo surfaces an **adaptive recommendation**, review the reasoning and accept or dismiss

### Building Toward Race Day

- **Run your regular routes often** — effort history builds with every repeat, and you'll start earning Gold/Silver/Bronze tiers
- **Monitor adherence** — above 85% correlates with stronger race outcomes
- **Watch your readiness grade climb** week by week as consistency compounds
- **Trust the taper** — Apollo adjusts recommendations in race week and will tell you when to ease off
- **On race day**, check your predicted marathon time on the Insights page — it's been refined across your entire training block

---

## Setup & Installation

### Desktop (Electron)

```bash
npm install
npm run dev
```

This starts both the Vite dev server and the Electron shell. The app opens automatically.

**Production build:**

```bash
npm run electron:build
```

Output: `release/` directory with platform-specific installers (NSIS on Windows, DMG on macOS, AppImage on Linux).

### Web (Browser Only)

**Development:**

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

**Production build:**

```bash
npm run build:web
npm run preview:web
```

**Full local stack (frontend + Azure Functions API):**

```bash
npm run build:web
npm install -g @azure/static-web-apps-cli
npm --prefix api install
npm run swa
```

Open [http://localhost:4280](http://localhost:4280).

Create `api/local.settings.json`:

```json
{
  "IsEncrypted": false,
  "Values": {
    "STRAVA_CLIENT_ID": "your-client-id",
    "STRAVA_CLIENT_SECRET": "your-client-secret",
    "BASE_URL": "http://localhost:4280"
  }
}
```

---

## Deploy to Azure Static Web Apps

Apollo is configured for Azure Static Web Apps with an Azure Functions API backend for Strava OAuth.

### 1. Create a Strava App

1. Go to [Strava API Settings](https://www.strava.com/settings/api)
2. Create an app
3. Set the callback domain to your site hostname only (no protocol or path), e.g., `your-app.azurestaticapps.net`
4. Save the Client ID and Client Secret

### 2. Create the Static Web App

In the Azure Portal:

- Create a **Static Web App**
- Connect this GitHub repository and branch
- Build settings:
  - **App location:** `/`
  - **Output location:** `dist`
  - **API location:** `api`
  - **App build command:** `npm ci && npm run build:web`

### 3. Add the GitHub Secret

Add a repository secret:

- `AZURE_STATIC_WEB_APPS_API_TOKEN` — the deployment token from Azure

### 4. Add Azure App Settings

| Name | Value |
|------|-------|
| `STRAVA_CLIENT_ID` | Your Strava Client ID |
| `STRAVA_CLIENT_SECRET` | Your Strava Client Secret |
| `BASE_URL` | `https://<your-app>.azurestaticapps.net` |

### 5. Deploy

Push to your deployment branch. GitHub Actions builds and deploys automatically.

---

## Running Tests

```bash
npm test              # single run
npm run test:watch    # watch mode
npm run test:coverage # with coverage report
```

**330 tests** across **11 test files**, all passing:

| Test File | Tests | Coverage Area |
|-----------|-------|--------------|
| plans | 52 | Plan library, custom builder, recommendation engine |
| effortService | 43 | Route fingerprinting, tier ranking, insight generation |
| splitService | 43 | Split processing, consistency grading, pattern detection |
| routeService | 41 | Polyline decoding, projection, haversine, bearing, caching |
| unitPreferences | 41 | Unit conversion, formatting, distance/pace/elevation |
| autoSync | 28 | Activity matching, mileage tracking, pace classification |
| backupService | 27 | Create, restore, verify, import, export, health monitoring |
| racePrediction | 20 | VDOT, Riegel, blending, confidence scoring |
| adaptiveTraining | 15 | Preference persistence, recommendation lifecycle, analytics |
| storage | 11 | Token management, credential security, web-mode guards |
| weeklyReadiness | 9 | Letter grading, boundary values, monotonic ordering |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18, TypeScript 5 (strict), Vite 7, React Router 6 |
| **Desktop** | Electron 40 with secure preload IPC |
| **Charts** | Recharts 3 (analytics) + custom pure SVG (routes, splits, gauges) |
| **Persistence** | localStorage + IndexedDB via Dexie 4 — dual-write, auto-hydration |
| **Web API** | Azure Functions (Node) for Strava OAuth token exchange |
| **Integrations** | Strava API v3 (OAuth2, rate-limited, mutex-protected refresh) |
| **Testing** | Vitest 4 with jsdom, 360 tests, v8 coverage |
| **Design** | Art Deco system — navy `#0D1B2A` + gold `#D4A537`, Montserrat / Inter / JetBrains Mono |

---

## Project Structure

```
src/
├── pages/                  Seven app pages + auth callback + 404
│   ├── Dashboard.tsx         Home — today's quest, stats, recaps, recommendations
│   ├── Training.tsx          Plan tracking — calendar + checklist + auto-sync
│   ├── Activities.tsx        Run history — list, detail, splits, effort recognition
│   ├── Analytics.tsx         Charts — mileage, pace, load, HR, consistency, PRs
│   ├── Insights.tsx          Coaching — predictions, readiness, recaps, HR zones
│   ├── RaceStrategy.tsx      Race pacing — marathon browser, strategy builder, imports
│   ├── Settings.tsx          Config — Strava, units, coaching, auto-sync, updates, backups
│   └── WelcomeFlow.tsx       Guided onboarding wizard (9 steps)
│
├── components/
│   ├── CalendarView.tsx      Monthly training calendar with day detail panel
│   ├── RouteMap.tsx          Pure SVG route visualization (thumbnail/card/detail)
│   ├── SplitAnalysis.tsx     Pace charts, split tables, consistency grading
│   ├── AdaptiveRecommendations.tsx  Coaching recommendation cards
│   ├── TierBadge.tsx         Gold/Silver/Bronze achievement badges
│   ├── ConnectStravaCTA.tsx  Strava connection prompt
│   ├── StrategyBuilder.tsx    Target time + pacing strategy → mile-by-mile plan
│   ├── MarathonBrowser.tsx   Filterable marathon card grid with course details
│   ├── MarathonImport.tsx    Custom marathon import form
│   ├── ElevationChart.tsx    Interactive SVG elevation profile with landmarks
│   ├── ErrorBoundary.tsx     React error boundary
│   └── LoadingScreen.tsx     Boot loading state
│
├── data/
│   ├── plans.ts              8 built-in plans + custom builder + recommendation engine
│   └── worldMajors.ts        6 World Marathon Majors with full course profiles
│
├── services/
│   ├── autoSync.ts           Smart Strava-to-plan matching + feedback generation
│   ├── routeService.ts       Polyline decoding, projection, caching
│   ├── effortService.ts      Route fingerprinting + effort ranking + insights
│   ├── splitService.ts       Split/lap processing + consistency analysis
│   ├── analyticsService.ts   Stats aggregation, charts data, PRs, streaks
│   ├── racePrediction.ts     VDOT + Riegel race time predictions
│   ├── weeklyReadiness.ts    5-factor readiness scoring
│   ├── adaptiveTraining.ts   Training pattern detection + recommendations
│   ├── dailyRecap.ts         Daily grade + coach messaging
│   ├── heartRate.ts          HR zones, distribution, trends, efficiency
│   ├── backupService.ts      Automatic backups with SHA-256 verification
│   ├── raceStrategy.ts        Strategy building, pacing, custom imports, persistence
│   ├── appPreferences.ts     Auto-sync and auto-update preferences
│   ├── coachingPreferences.ts  Scheduling and notification settings
│   ├── unitPreferences.ts    Miles/km toggle + all conversion helpers
│   ├── strava.ts             Strava API client (rate-limited, mutex refresh)
│   ├── stravaWeb.ts          Web-mode Strava OAuth helpers
│   ├── garmin.ts             Garmin API scaffolding
│   ├── storage.ts            Cross-platform token/credential management
│   ├── dataManager.ts        Export/import with validation
│   ├── planProgress.ts       Plan state, completion tracking, sync metadata
│   └── db/
│       ├── apolloDB.ts         Dexie IndexedDB schema
│       └── persistence.ts      Unified persistence layer (cache + IDB + localStorage)
│
├── styles/
│   └── design-system.css     Full Art Deco design system (CSS custom properties)
│
├── hooks/
│   └── useAdaptiveRecommendations.ts
│
├── types/
│   ├── recommendations.ts
│   └── raceStrategy.ts       Marathon, strategy, pacing, elevation types
│
└── __tests__/                360 tests across 12 files
    └── setup.ts              Test harness with in-memory persistence mock

electron/                     Electron main process + secure preload
api/                          Azure Functions (Strava token exchange)
public/                       Static assets, PWA manifest, SWA config
```

---

## License

MIT © Marc Copeland
