<p align="center">
  <img src="public/assets/logo-1024.png" alt="Apollo" width="140" />
</p>

<h1 align="center">Apollo</h1>

<p align="center">
  <strong>The definitive marathon training platform.</strong><br />
  Smart plans · Free sync via intervals.icu · Garmin/Strava/Zwift file import · Workouts to your watch · Nutrition science · Race day intelligence<br />
  <em>Local-first. Zero subscriptions. No Apollo account, no Apollo servers — your data stays on your device.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/tests-1431%20passing-brightgreen" alt="1431 tests passing" />
  <img src="https://img.shields.io/badge/services-53-blue" alt="53 services" />
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
  - [Daily Recovery Check](#daily-recovery-check)
- [Race Strategy](#race-strategy)
  - [World Marathon Majors Database](#world-marathon-majors-database)
  - [Strategy Builder](#strategy-builder)
  - [Custom Marathon Import](#custom-marathon-import)
- [Data Safety & Backups](#data-safety--backups)
- [Nutrition Science Engine](#nutrition-science-engine)
  - [Glycogen Depletion Model](#glycogen-depletion-model)
  - [Hydration Calculator](#hydration-calculator)
  - [Carb Loading Protocol](#carb-loading-protocol)
  - [In-Race Fueling Calculator](#in-race-fueling-calculator)
- [Performance Analytics](#performance-analytics)
  - [What-If Simulator](#what-if-simulator)
  - [Fatigue Resistance Index](#fatigue-resistance-index)
  - [Pacing Decay Analysis](#pacing-decay-analysis)
  - [Race Equivalence Engine](#race-equivalence-engine)
  - [Aerobic Decoupling](#aerobic-decoupling)
- [Race Day Intelligence](#race-day-intelligence)
  - [Ghost Runner](#ghost-runner)
  - [Race Day Timeline](#race-day-timeline)
  - [Course-Specific Training](#course-specific-training)
  - [Taper Optimizer](#taper-optimizer)
  - [Bonk Risk Assessment](#bonk-risk-assessment)
- [Weather Integration](#weather-integration)
- [Calendar Export](#calendar-export)
- [Pre-Race Checklist](#pre-race-checklist)
- [Post-Race Analysis](#post-race-analysis)
- [Printable Race Card](#printable-race-card)
- [Training Periodization](#training-periodization)
- [Performance Management Chart (PMC)](#performance-management-chart-pmc)
- [Running Economy Tracker](#running-economy-tracker)
- [Structured Workouts & VDOT Pacing](#structured-workouts--vdot-pacing)
- [Training Journal & Shoe Tracking](#training-journal--shoe-tracking)
- [Integrations](#integrations)
  - [intervals.icu](#intervalsicu-free--recommended)
  - [Workouts to Your Watch](#workouts-to-your-watch)
  - [File & Archive Import](#file--archive-import-no-account-needed)
  - [Strava (optional)](#strava-optional)
- [Security & Privacy](#security--privacy)
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

Apollo is different. It combines the depth of a professional coaching platform with the simplicity of a personal training log — and it runs entirely on your machine. No subscriptions. No data harvesting. No Apollo account.

What sets Apollo apart:

- **Free sync with every major platform** — Connect a free [intervals.icu](https://intervals.icu) account and Apollo pulls every run, ride, and swim recorded on Garmin, COROS, Suunto, Polar, Wahoo, Zwift, and more — full history on the first sync, incremental after that. Prefer zero accounts? Drag in FIT/GPX/TCX files or your whole Garmin/Strava data export. Strava's paid API is supported too, but never required.
- **Your plan on your wrist** — Push your training plan to the intervals.icu calendar with VDOT-calibrated paces, and intervals.icu delivers each structured workout to your Garmin, COROS, Suunto, or Wahoo watch.
- **Recovery that reads your watch** — Sleep, HRV, and resting heart rate sync free from intervals.icu into a daily recovery check that compares today against *your* normal ranges and tells you when to back off.
- **Plans from the coaches who wrote the book** — Hal Higdon, Hanson's, Pfitzinger, Nike Run Club, and FIRST. Or build your own from scratch with our custom plan builder.
- **A research-grade nutrition and physiology engine** — Mile-by-mile glycogen depletion modeling (Brooks & Mercier 1994), personalized sweat rate calculations (Sawka 2007), evidence-based carb loading protocols (Burke 2011), and in-race fueling plans with caffeine optimization (Jeukendrup 2014, Goldstein 2010). This is the science that sports dietitians charge $200+ to deliver.
- **What-if scenario planning** — "What if I lose 10 lbs?" "What if I miss two weeks?" Apollo quantifies the time impact using published research (Hoogkamer 2016, Mujika & Padilla 2000) so you make informed decisions, not guesses.
- **Intelligence that earns its name** — Race predictions refined across your entire training block. Adaptive recommendations that detect overtraining before you feel it. Fatigue resistance indexing, pacing decay curves, aerobic decoupling analysis, a 7-factor bonk risk score, automatic training periodization detection, a full Performance Management Chart (CTL/ATL/TSB), and running economy tracking that catches overtraining early.
- **Race day as a system, not a hope** — Ghost runner comparisons, a complete race morning timeline, course-specific training for all six World Marathon Majors, Banister fitness-fatigue taper optimization, bonk risk assessment, printable race cards, and customizable pre-race checklists. Every tool you need from taper through finish line.
- **Post-race learning built in** — Compare your actual splits to your strategy mile-by-mile. Get graded on execution (A+ to F). Automatic wall detection, early-pace analysis, and lessons-learned capture for your next race.
- **Weather-aware race planning** — Opt-in Open-Meteo integration with heat-adjusted marathon predictions using the Ely model, risk assessment, and course-specific forecasts for all World Majors.
- **Export your plan anywhere** — One-click .ics calendar export with VDOT-paced workout descriptions. Works with Google Calendar, Outlook, and Apple Calendar.
- **Every run tells a richer story** — Route maps rendered as Art Deco artwork. Split-level pacing breakdowns. Effort recognition that remembers every time you've run that neighborhood loop and tells you exactly how today compared.
- **Your data, your device** — localStorage + IndexedDB. Automatic backups with SHA-256 integrity verification. Export everything as JSON. Nothing leaves your machine.
- **Security-hardened** — OS-level credential encryption via Electron's safeStorage API, Content Security Policy headers, navigation guards, IPC key allowlisting, coordinate validation, and HTML entity escaping. Zero `eval()`, zero `dangerouslySetInnerHTML`, zero hardcoded secrets.
- **1,431 tests, zero failures** — Every formula, constant, and physiological model validated against peer-reviewed research with comprehensive edge case coverage.

---

## Quick Start

```bash
git clone https://github.com/LetsLearntocodeforfun/Apollo-Running.git
cd Apollo-Running
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser. Apollo's guided onboarding will walk you through choosing a plan, setting your start date, picking your preferred units, and configuring coaching preferences.

To bring in your runs — free via intervals.icu, by importing files/exports, or via Strava if you have API access — see [Integrations](#integrations).

---

## Features at a Glance

| Feature | What It Does |
|---------|-------------|
| **8 marathon plans** | Hal Higdon (4), Hanson's, Pfitzinger, Nike, FIRST — plus a custom plan builder |
| **Free activity sync** | intervals.icu connection (free) pulls runs, rides, and swims from Garmin, COROS, Suunto, Polar, Wahoo, Zwift — full history, then incremental |
| **File & archive import** | Drag-and-drop FIT, GPX, TCX (and `.gz`), or an entire Garmin/Strava account export ZIP — no account needed |
| **Workouts to your watch** | Push the plan to your intervals.icu calendar with VDOT paces; intervals.icu uploads it to Garmin, COROS, Suunto, and Wahoo watches |
| **Recovery check** | Sleep, HRV, and resting HR from your watch (via intervals.icu) → daily status and training suggestion; also feeds coach messages and your HR profile |
| **Cross-training** | Rides, swims, strength, and Zwift sessions count toward cross-training days and training load |
| **Training calendar** | Monthly grid with workout types, intensity colors, sync status, click-to-expand day detail |
| **Smart auto-sync** | Matches synced or imported runs to plan days, auto-completes workouts, generates coaching feedback |
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
| **Auto-sync on launch** | Opt-in automatic sync when the app opens, plus optional background re-sync while it's open (default hourly), with a 5-minute cooldown |
| **Auto-updates** | Opt-in update checking, downloading, and installing (Electron desktop) |
| **Miles & kilometers** | One toggle changes every number in the entire app |
| **Glycogen model** | Mile-by-mile glycogen depletion simulation with substrate crossover from Brooks & Mercier (1994) |
| **Hydration calculator** | Personalized sweat rate modeling with sex, temperature, humidity, and sun exposure adjustments (Sawka 2007) |
| **Carb loading protocol** | 3-day evidence-based protocol generator with meal-specific targets (Burke 2011) |
| **In-race fueling** | Complete fueling plan with carb rate, gel schedule, and caffeine strategy (Jeukendrup 2014) |
| **What-If simulator** | "What if I lose 10 lbs?" — quantified time impact for 7 training scenarios (Hoogkamer 2016) |
| **Fatigue Resistance Index** | Last 30%/first 70% pace ratio analysis with anomalous split filtering |
| **Pacing decay** | Personal decay curve modeling with race-day pace predictions |
| **Race equivalence** | Normalize race times across heat, humidity, altitude, and wind (Ely 2007, Péronnet 1991) |
| **Aerobic decoupling** | Cardiac drift analysis with Friel-standard thresholds |
| **Ghost runner** | Mile-by-mile race comparison with cumulative lead/deficit tracking |
| **Race day timeline** | Complete race morning schedule — alarm, meal, travel, warmup, corral, all timed to gun time |
| **Course training** | World Marathon Major-specific preparation plans for all 6 majors |
| **Taper optimizer** | Banister fitness-fatigue model (CTL/ATL/TSB) with auto-generated taper plans |
| **Bonk risk score** | 7-factor weighted assessment predicting wall probability (0-100) |
| **Structured workouts** | VDOT-paced targets for easy, tempo, interval, repetition, and long runs |
| **Training journal** | Rich-text journal entries with mood, effort, and searchable history |
| **Shoe tracking** | Mileage tracking per shoe with rotation and retirement alerts |
| **Weather integration** | Opt-in Open-Meteo forecasts with heat-adjusted predictions (Ely model) |
| **Calendar export** | One-click .ics export with VDOT-paced workout descriptions for Google/Outlook/Apple Calendar |
| **Pre-race checklist** | 40+ default items with course-specific templates for all 6 World Majors |
| **Post-race analysis** | Mile-by-mile actual vs planned comparison with grading (A+ to F) and wall detection |
| **Printable race card** | One-page print-optimized race companion with splits, nutrition, pace bands, 5K checkpoints, segment summaries, and mantras |
| **Training periodization** | Automatic phase detection (Base → Build → Peak → Taper → Race) with phase-aware coaching tips |
| **Performance Management Chart** | CTL/ATL/TSB fitness-fatigue tracking with zone classification, forward projections, and readiness scoring |
| **Running economy tracker** | Pace-to-HR efficiency ratio trending, decline detection (overtraining signal), and personal best tracking |

---

## The Training Calendar

The crown jewel of the Training page. A full monthly calendar view that shows your entire training block at a glance — designed to rival and surpass what you'd find in TrainingPeaks or Strava.

**At the grid level:**
- Each day cell shows the **workout type** with color-coded intensity bars (green = easy, gold = long run, orange = tempo, red = speed, teal = cross training)
- **Workout icons** indicate the session type (🟢 Easy · 🟡 Long · 🟠 Tempo · 🔴 Speed · 🏁 Race · 🏅 Marathon)
- **Distance** displayed per day — with actual/planned shown side-by-side when an activity is synced or imported
- **Mini progress bars** visualize how close your actual distance came to the plan target
- **Completion badges** — gold ✓ for auto-synced days (intervals.icu, Strava, or file import), green ✓ for manually completed; cross-training days show the sport icon and duration
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

- **Personalized greeting** with your athlete name and data-source connection status
- **Today's Quest** — a hero card showing today's planned workout, with distance, type, and (once synced) your actual metrics, coaching feedback, route map, and effort recognition
- **Recovery check** — last night's sleep, resting HR, and HRV from your watch (via intervals.icu), with a daily status (*Recovered / OK / Caution*) and a one-line suggestion such as "keep today easy"
- **Plan progress bar** — percentage complete with days-completed count
- **Stats strip** — race prediction, training adherence, and readiness grade at a glance
- **Adaptive recommendations** — intelligent coaching cards when Apollo detects something actionable (overtraining, schedule gap, race week)
- **Daily recap** — pop-up card with your training grade and coach message
- **Weekly readiness** — pop-up with your composite score, strengths, and tips for the week ahead
- **Recent activities** — your last five runs with route thumbnails, distance, pace, and effort tier indicators

Opening the Dashboard syncs when a data source (intervals.icu or Strava) is connected and a plan is active — or, if Apollo synced in the last 10 minutes, simply re-matches what's already on your device. Imported files are matched to the plan the moment they land. No manual action needed.

### ⚡ Training Plan

Where your plan lives.

- **Plan selection** — browse all eight built-in plans displayed as cards, or access the custom plan builder through the Welcome Flow
- **Calendar view** *(new)* — the monthly training calendar described above
- **Checklist view** — the traditional week-by-week accordion with expandable day rows showing checkboxes, dates, workout labels, sync badges, tier badges, route thumbnails, and detailed metrics
- **Weekly mileage bars** — per-week actual vs planned with color-coded status (on track / ahead / behind)
- **Smart Auto-Sync card** — manual sync trigger, last sync timestamp, and detailed results for every matched activity
- **Send to your watch** — push the plan to your intervals.icu calendar as structured workouts (warm-up, repeats, tempo, marathon-pace segments with your VDOT paces); intervals.icu forwards them to Garmin, COROS, Suunto, and Wahoo watches. Optional auto-update keeps the next 4 weeks in step when your plan, start date, paces, or units change

### 🏅 Activities

Your complete training history — runs, rides, swims, strength, and indoor sessions.

- **Sport filters** — All / Runs / Rides / Other, with counts
- **Source badges** — where each activity came from (intervals.icu, Strava, or file import), plus an *Indoor* pill for trainer, Zwift, and treadmill sessions
- **Import files** — add FIT/GPX/TCX files or a full Garmin/Strava export right from the Activities page (drag-and-drop or file picker)
- **Paginated activity list** — 30 per page, each row showing route thumbnail, activity name with tier dot, date, and sport-appropriate metrics (pace, elevation, and HR for runs; speed, power, and HR for rides; HR and training load for everything else)
- **Expandable detail panel** (click any activity):
  - Full-size route map with animation, mile markers, and compass (any sport with GPS)
  - Stats grid: distance, duration, pace, elevation, HR (avg + max), cadence, power, training load
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

**Overview** — Race prediction with marathon, half, 10K, and 5K times. VDOT score and confidence percentage. Score gauges for adherence, readiness, distance match, and consistency. Detailed adherence and readiness breakdowns with strengths, improvements, and tips. The full [recovery check](#daily-recovery-check) — sleep, resting HR, and HRV against your own baselines, with the reasons behind today's status. Today's training recap. Readiness history across weeks.

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

- **intervals.icu (free, recommended)** — paste your API key once; Apollo verifies it, encrypts it at rest, and imports your full history. Buttons for *Sync now* and *Re-import full history*, with live progress and last-sync status. If the desktop keychain is unavailable (e.g. Linux without a keyring), Apollo says so instead of silently forgetting the key
- **Sync sleep, HRV and resting HR** — on by default; powers the Recovery check and keeps your resting/max HR current (never overrides values you entered yourself)
- **Import files** — FIT/GPX/TCX files (optionally `.gz`) or a whole Garmin Connect / Strava account export ZIP; duplicates are detected and merged automatically
- **Workouts to your watch** — push the active plan to your intervals.icu calendar, remove it again, or keep it auto-updated
- **Strava (optional)** — for accounts with Strava API access: one-click OAuth on web; Client ID + Secret fields on desktop
- **Distance units** — miles or kilometers, one toggle that changes everything app-wide
- **Auto-sync on launch** — opt-in automatic sync of every connected source when the app opens, plus an optional background re-sync interval while it stays open (5-minute cooldown prevents redundant syncs)
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
9. **Complete** — ready to train; Apollo points you to Settings to connect intervals.icu (free), import your files, or link Strava

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

Connect a data source once — or import your files — and Apollo handles the rest.

**How it works:**
1. **First sync imports your full history** from every connected source (intervals.icu and/or Strava), year by year; after that, each sync is incremental (new and recently edited activities only)
2. **Duplicates are merged automatically** — the same run recorded on your watch, synced to intervals.icu, and imported from a FIT file is stored once, keeping the richest data from each copy
3. Each run is matched to a plan day by date (if multiple runs on the same day, the longest one is used); **cross-training days** are fulfilled by rides, swims, Zwift, or strength sessions of 10+ minutes
4. Matched workouts are auto-completed
5. For each match, Apollo generates **coaching feedback** — distance analysis against the target, pace commentary tailored to the workout type (easy, tempo, speed, long), and weekly mileage status

**After every sync or import, Apollo also:**
- Captures heart rate data for zone analysis and efficiency tracking
- Processes route effort recognitions (repeated route detection + tier ranking)
- Updates race predictions with the latest data
- Recalculates training adherence and weekly readiness
- Generates daily recap and adaptive recommendations if due

This happens automatically when you open the Dashboard or Training page, on launch and in the background if you enable auto-sync, and immediately after a file import — no internet needed for imported files.

---

## Route Maps

Every synced or imported activity with GPS is rendered as a pure SVG route visualization. No Leaflet. No Mapbox. No API keys. Works fully offline.

- **Polyline decoding** — GPS tracks from intervals.icu streams, imported FIT/GPX/TCX files, or Strava are stored as compact encoded polylines and decoded into coordinates
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

Each recap includes actual distance vs planned (with ± percentage), pace, duration, HR zone, and a workout-specific message. If you ran an easy day at threshold pace, Apollo will flag it. If you crushed a long run, Apollo acknowledges it. Short sleep — from your journal or synced from your watch — gets a recovery reminder. Up to 365 days of recap history.

### Daily Recovery Check

With intervals.icu connected, Apollo syncs the wellness data your watch or ring records — sleep, resting heart rate, HRV (rMSSD), plus any fatigue/soreness/stress you log in intervals.icu — and compares today against **your own** baselines rather than population norms:

| Signal | Compared with | Flagged when |
|--------|---------------|--------------|
| **HRV** | 7-day rolling average (log rMSSD) vs your 60-day normal range (mean ± 0.5 SD) | Below your normal range; strongly below = more than 1 SD under your mean |
| **Resting HR** | Today vs your 30-day average | 5+ bpm above (10+ bpm is a strong signal) |
| **Sleep** | Last night vs a 7-hour floor and your 7-night average | Under 6 h, or under 7 h and an hour below your usual (under 5 h is a strong signal) |
| **How you feel** | Fatigue, soreness, or stress logged in intervals.icu | Rated 3+ on the 1–4 scale |

**Recovered** means no warning signs; **OK** means one signal (train as planned, back off if the warm-up feels hard); **Caution** means one strong or two signals (keep today easy or swap with a rest day). Until there's about a week of data, Apollo says it's still learning your ranges. The approach follows rolling-average HRV guidance from Plews et al. (2013) and Buchheit (2014). It's training guidance, not medical advice.

The same sync keeps your HR profile current: resting HR from the median of the last 14 days, and max HR / LTHR from your intervals.icu run settings — never overriding values you entered yourself.

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

**Zone distribution chart** (last 30 days) with 80/20 rule guidance — most training should be in Zones 1–2. **HR trend chart** showing daily averages. **Aerobic efficiency tracking** (pace-to-HR ratio over time). Auto-detects and updates max HR when a synced or imported activity reports a higher value. With intervals.icu connected, resting HR follows your watch's recent readings and max HR / LTHR come from your intervals.icu run settings — unless you've entered your own values.

---

## Nutrition Science Engine

Apollo includes a research-grade nutrition science engine — the kind of analysis that previously required a sports dietitian or lab testing. Every model is grounded in peer-reviewed literature.

### Glycogen Depletion Model

Mile-by-mile simulation of glycogen stores during a marathon, using the logistic crossover model from Brooks & Mercier (1994).

- **Base glycogen:** 450g (normal) or 700g (carb-loaded) — per Romijn et al. (1993)
- **Substrate partitioning:** VO2max-aware glycogen/fat ratio that shifts toward fat burning at lower intensities
- **Critical threshold:** Predicts the exact mile where glycogen drops below 75g ("hitting the wall")
- **Fueling simulation:** Model the effect of in-race carb intake on depletion timing
- **`willGlycogenLast`:** Quick yes/no assessment with plain-language explanation

### Hydration Calculator

Personalized sweat rate modeling based on the ACSM Position Stand (Sawka et al. 2007).

- **Base sweat rate:** 800 ml/hr adjusted for temperature (+10 ml/hr per °F above 55°F), humidity (+5 ml/hr per % above 40%), and sun exposure
- **Sex adjustment:** Female runners at 0.83× male rate
- **Replacement ratio:** 70% of sweat loss — the evidence-based target for performance maintenance
- **Safety cap:** Recommended intake never exceeds 1000 ml/hr (hyponatremia prevention)
- **Aid station planning:** Generates per-station fluid intake targets when aid station locations are provided
- **Dehydration risk assessment:** Low/moderate/high/extreme rating with explanatory messaging

### Carb Loading Protocol

Evidence-based 3-day carb loading protocol generator following Burke et al. (2011).

| Day | Target | Example (70kg runner) |
|-----|--------|----------------------|
| D-3 | 8 g/kg/day | 560g carbs |
| D-2 | 10 g/kg/day | 700g carbs |
| D-1 | 12 g/kg/day | 840g carbs |
| Race morning | 2.5 g/kg | 175g carbs |

- **Meal-by-meal breakdown** with specific food suggestions and portion sizes
- **Scales to body weight** — works for 40kg to 130kg runners
- **Race morning timing** — aligned with ACSM's 3-hour pre-race meal recommendation

### In-Race Fueling Calculator

Complete in-race fueling plan with carb rate optimization (Jeukendrup 2014) and caffeine strategy (Goldstein 2010).

- **Carb rate:** 30-90 g/hr based on pace, experience level, and gut training status
- **Gel schedule:** Mile-specific gel timing coordinated with aid stations
- **Caffeine dosing:** 3-6 mg/kg range with timing recommendations (Goldstein 2010)
- **GI risk assessment:** Warns when carb rate may exceed gut absorption capacity
- **Product preferences:** Supports gels, chews, drinks, and real food

---

## Performance Analytics

Novel analytical tools that quantify aspects of marathon performance no consumer app has measured before.

### What-If Simulator

Quantified "what if" scenarios with time impact projections grounded in published research.

| Scenario | Research Basis | Example |
|----------|---------------|--------|
| **Weight change** | Hoogkamer (2016): ~2 sec/mi per lb | "Lose 10 lbs → save ~8:44" |
| **Increase mileage** | Dose-response fitness curve | "+20% volume → ~12 min faster" |
| **Skip days** | Mujika & Padilla (2000) detraining | "2 weeks off → ~8 min slower" |
| **Add long runs** | Long run specificity research | "Add weekly 20-miler → ~5 min faster" |
| **Marathon pace runs** | Race-specific endurance | "MP long runs → ~4 min faster" |
| **Add tempo runs** | Lactate threshold development | "Weekly tempo → ~6 min faster" |
| **Decrease mileage** | Inverse dose-response | "-30% volume → ~9 min slower" |

All projections are VDOT-calibrated and capped at physiologically realistic bounds.

### Fatigue Resistance Index

Quantifies your ability to maintain pace in the final miles — the single most important predictor of marathon success.

- **FRI formula:** (average pace, last 30% of run) / (average pace, first 70%) × 100
- **Rating scale:** ≤100 Excellent · ≤103 Good · ≤106 Fair · ≤110 Needs Work · >110 Severe Fade
- **Anomalous split filtering:** Removes bathroom breaks and GPS glitches (1.4× median threshold)
- **Minimum requirements:** 16+ miles, 10+ splits — only long runs qualify
- **Trend tracking:** FRI progression across your training block

### Pacing Decay Analysis

Models your personal pacing decay curve from long run data and predicts race-day pacing.

- **Linear regression** fit across all qualifying long runs (16+ miles, 3+ runs minimum)
- **Stable phase detection:** Miles 3-8 identified as "settled pace" baseline
- **Ideal decay benchmarks** by target time:
  - Sub-2:45: 0.4%/mi
  - Sub-3:00: 0.5%/mi
  - Sub-3:30: 0.7%/mi
  - Sub-4:00: 0.9%/mi
  - 4:00+: 1.2%/mi
- **Race pacing projection:** Mile-by-mile predicted paces for your target pace
- **Gap analysis:** Your decay vs ideal with coaching interpretation

### Race Equivalence Engine

Normalize any marathon time to ideal conditions — or convert between any two sets of conditions.

| Factor | Coefficient | Source |
|--------|------------|--------|
| Heat | +1.75% per 10°F above 55°F | Ely et al. (2007) |
| Humidity | +0.5% per 10% above 40% | Maughan (2010) |
| Headwind | +1.5% per 10 mph | Pugh (1971) |
| Altitude | +0.91% per 1000 ft | Péronnet et al. (1991) |

- **Normalize to ideal:** "Your 3:15 in 80°F heat is equivalent to 3:07 in ideal conditions"
- **Convert between conditions:** "Your 3:07 at sea level = 3:14 at 5,280 ft (Denver)"
- **Bidirectional:** Works in both directions with approximately inverse results

### Aerobic Decoupling

Cardiac drift analysis following Joe Friel's methodology.

- **Formula:** ((HR₂/Pace₂) / (HR₁/Pace₁) - 1) × 100
- **Thresholds:** <5% Excellent (aerobically strong) · 5-10% Adequate · >10% Needs Work (insufficient base)
- **Filters:** Removes low HR readings (<90 bpm) to exclude sensor errors
- **Minimum:** 6+ splits, 8+ miles required
- **What it tells you:** Whether your aerobic base is strong enough to support marathon distance

---

## Race Day Intelligence

Five integrated tools that transform race week from stressful guesswork into a data-driven plan.

### Ghost Runner

Mile-by-mile comparison between any two runs — like racing against your past self.

- **Cumulative delta tracking:** See exactly where you're ahead or behind at every mile marker
- **Per-mile deltas:** Identify which segments made the difference
- **Trend analysis:** Improving, stable, or declining across compared efforts
- **Auto-alignment:** Compares to the shorter of two runs when distances differ

### Race Day Timeline

Complete race morning schedule, timed backward from the starting gun.

- **Events generated:** Alarm, breakfast (3 hours pre-race per ACSM), leave for venue, arrive, gear check, warmup, corral entry, gun time, projected finish, post-race recovery
- **Pre-race carb target:** 1-4 g/kg scaled to body weight with specific food suggestions
- **Configurable:** Travel time, meal preference (light/moderate/full), warmup toggle
- **Text export:** Share your race morning plan as formatted text

### Course-Specific Training

World Marathon Major-specific preparation plans tailored to each course's unique demands.

| Major | Training Focus |
|-------|---------------|
| **Boston** | Hill repeats, downhill training, Heartbreak Hill simulation, quad-eccentric work |
| **New York** | Bridge climbs, 5-borough terrain variety, Central Park finish hills |
| **Chicago** | Wind resistance training, flat-course pacing discipline |
| **London** | Even pacing on flat terrain, Thames path simulation |
| **Berlin** | PB-focused speed work, pace discipline for the world's fastest course |
| **Tokyo** | Heat/humidity adaptation, early-race conservative pacing |
| **Generic** | Adapts to hilly vs flat based on course profile |

### Taper Optimizer

Banister fitness-fatigue model implementation with auto-generated taper plans.

- **Chronic Training Load (CTL):** 42-day exponentially weighted average — your fitness
- **Acute Training Load (ATL):** 7-day exponentially weighted average — your fatigue
- **Training Stress Balance (TSB):** CTL - ATL — your freshness (positive = ready to race)
- **TSS estimation:** Training Stress Score by workout type (easy, tempo, interval, long run, race)
- **Auto-generated taper:** Progressive volume reduction targeting positive race-day TSB
- **Weekly reduction schedule:** Gradual decrease over 2-3 weeks calibrated to your current ATL/CTL ratio

### Bonk Risk Assessment

7-factor weighted risk score (0-100) predicting the probability of hitting the wall.

| Factor | Weight | What It Measures |
|--------|--------|------------------|
| Distance Readiness | 25% | Longest run distance relative to 26.2 mi |
| Long Run Frequency | 15% | Number of 18+ mile runs completed |
| Fueling Practice | 15% | In-race nutrition rehearsal during training |
| Pace Aggression | 15% | Race pace vs training pace differential |
| Carb Loading | 10% | Carb loading protocol completion |
| Experience | 10% | Marathon experience level (beginner → advanced) |
| Heat Risk | 10% | Race-day temperature impact |

- **Risk levels:** Low (0-30) · Moderate (31-55) · High (56-75) · Very High (76-100)
- **Actionable factors:** Each factor shows its individual score so you can address specific weaknesses
- **Summary messaging:** Plain-language assessment of your wall risk and what to do about it

---

## Weather Integration

Opt-in weather forecasting powered by the [Open-Meteo API](https://open-meteo.com/) — free, no API key, no account required.

**Forecast data:**
- 7-day forecast: temperature (high/low/avg/feels-like), humidity, wind speed + gusts, precipitation probability, UV index, sunrise/sunset
- Weather condition categorization: clear, partly cloudy, cloudy, fog, drizzle, rain, snow, thunderstorm
- World Marathon Major coordinates built in — one call to get the forecast for Boston, New York, Chicago, London, Berlin, or Tokyo

**Performance impact modeling:**
- **Heat adjustment** — the Ely model: +1.75% slowdown per 10°F above 55°F, +0.5% per 10% humidity above 40%
- **Risk level assessment** — five tiers: Ideal → Good → Caution → Warning → Danger, computed from temperature, humidity, and wind
- **Adjusted race time** — "Your 3:30 target becomes 3:38 in 75°F heat and 70% humidity"

**Tips engine** — contextual race-day advice based on conditions:
- High heat: start 5-10 sec/mi slower, increase fluid intake, wear light colors
- Strong wind: draft behind groups, expect slower miles on exposed stretches
- Rain: waterproof your bib, petroleum jelly for chafing, hat to keep rain out of eyes

**Caching:** 3-hour cache with coordinate-based keys. Fully offline-safe — returns null gracefully when no network is available.

---

## Calendar Export

Export your entire training plan as a standard `.ics` (iCalendar) file. One-click import into Google Calendar, Outlook, Apple Calendar, or any RFC 5545-compliant calendar app.

**What each event includes:**
- **Title** — workout type and distance (e.g., "Long Run — 20 mi")
- **Duration** — estimated from VDOT pace zones: easy runs at easy pace, tempo runs at threshold pace, marathon-pace runs at marathon pace
- **Description** — VDOT pace targets, interval structure, and workout guidance
- **Unique IDs** — RFC 5545-compliant UIDs for clean re-import without duplicates

**Export options:**
- Include or exclude rest days
- Export the full plan or any individual plan
- Download triggers a browser-native file save

**Duration estimation:**
- Uses your saved VDOT training paces when available
- Falls back to 9:30/mi for new users
- Long runs add 15 sec/mi to easy pace to account for fatigue
- Interval workouts calculate work + rest + warmup + cooldown time

---

## Pre-Race Checklist

Customizable race-day checklists with course-specific templates for all six World Marathon Majors.

**40+ default items across 6 categories:**

| Category | Example Items |
|----------|--------------|
| **Gear** | Race shoes, race outfit, GPS watch, body glide, sunglasses, hat |
| **Nutrition** | Gels, electrolyte tabs, race morning breakfast, water bottle |
| **Logistics** | Bib pickup, travel arrangements, hotel/parking, bag drop plan |
| **Morning of** | Alarm set, breakfast timed, sunscreen, dynamic warmup |
| **Mental** | Review race strategy, set mantras, visualize key miles |
| **Post-race** | Recovery clothes, foam roller, post-race meal planned |

**Course-specific templates:**

| Marathon | Added Items |
|----------|------------|
| **Boston** | Warm layers for Hopkinton, bus schedule, discard clothes, Newton Hills strategy |
| **New York** | Fort Wadsworth logistics, 5-bridge strategy, Queensboro mental plan |
| **Chicago** | Lakefront wind layers, wind protection strategy |
| **London** | Rain gear backup, cobblestone section awareness |
| **Berlin** | Flat-course pacing discipline, Brandenburg Gate finish plan |
| **Tokyo** | Humidity gear, food station awareness |

**Checklist management:**
- Create multiple checklists (one per race)
- Add custom items to any category
- Check/uncheck items with progress tracking (e.g., "18/42 items complete — 43%")
- Reset checklist to start fresh
- Delete checklists you no longer need
- All data persisted locally

---

## Post-Race Analysis

After a marathon, compare your actual execution to your planned strategy mile by mile. This is how you learn.

**Mile-by-mile comparison:**
- Each mile gets a verdict: `on_target`, `too_fast`, or `too_slow`
- Shows pace delta (planned vs actual) and cumulative time delta
- Identifies exactly where you gained or lost time

**Split analysis:**
- First half vs second half comparison
- Automatic classification: negative split, even split, or positive split
- Split differential in seconds

**5-segment breakdown:**
- Miles 1-5, 6-10, 11-15, 16-20, 21-26.2
- Average pace per segment vs planned
- Identifies which segments cost you time

**Grading system (A+ to F):**

| Grade | Points | Criteria |
|-------|--------|----------|
| A+ | 95-100 | Near-perfect execution |
| A | 90-94 | Excellent pacing discipline |
| A- | 85-89 | Strong execution with minor drift |
| B+ | 80-84 | Good execution |
| B | 75-79 | Solid effort, some pacing errors |
| B- | 70-74 | Noticeable pacing issues |
| C+ | 65-69 | Significant room for improvement |
| C | 55-64 | Major execution errors |
| D | 45-54 | Poor pacing discipline |
| F | 0-44 | Strategy largely abandoned |

**Scoring factors:**
- Finish time delta from target (max 30 penalty points)
- Pace inconsistency across miles (max 30 penalty points)
- Early miles too fast, miles 1-5 (max 20 penalty points)
- Late-race fade, miles 20+ (max 20 penalty points)
- Negative split bonus: +5 points

**Automated insights:**
- **Wall detection** — flags when miles 20+ slow by >20 seconds vs earlier pace
- **Early pace mistakes** — warns when miles 1-5 are >10 sec/mi faster than planned
- **Consistency metrics** — reports your most and least consistent segments
- **Lessons learned** — free-text field to capture what you'd do differently

**Report management:** Save, retrieve, compare multiple race reports, update lessons learned post-reflection.

---

## Printable Race Card

A one-page race day companion, optimized for print. Tape it to your arm, clip it to your shorts, or slip it in your pocket. Everything you need at a glance during the race.

**Mile splits table:**
- 26 rows with target pace, cumulative time, elevation note, nutrition cue, and personal mantra per mile
- Half-marathon row highlighted for quick reference
- Monospace font for instant pace readability

**Pace bands:**
- Three bands — Goal, Conservative (+10 sec/mi), Aggressive (-10 sec/mi)
- Each with pace per mile, 5K split, half split, and projected finish time
- Compare to your watch at any checkpoint

**5K checkpoint splits (v2):**
- 9 checkpoints: 5K, 10K, 15K, 20K, Half, 25K, 30K, 35K, 40K
- Each with split time (since last checkpoint) and cumulative clock time
- Half-marathon row highlighted — compare to your watch at every timing mat

**Segment summary (v2):**
- Miles grouped into 5-mile segments (1-5, 6-10, 11-15, 16-20, 21-25, 26)
- Average pace and total time per segment
- Instantly see if your plan calls for even splits or a negative split

**Elevation warnings:**
- Auto-generated for significant climbs (>50 ft) and descents (>80 ft)
- Coaching cue: "maintain effort, not pace" for climbs; "control pace, protect quads" for descents

**Nutrition timeline:**
- Every gel/fuel item from your race strategy, shown at the correct mile

**Personal mantras:**
- Assign mantras to specific miles — they appear in the splits table
- Default mantras storable in preferences

**Additional sections:**
- Weather summary (from weather integration)
- Emergency contact (name + phone)
- Notes (corral number, wave start time, special instructions)

**Output:**
- Print-optimized HTML with `@media print` CSS
- Apollo gold branding, compact 9pt layout
- Download as `.html` file or open print dialog directly
- HTML entity escaping on all user input (XSS-safe via Blob URL pattern)

---

## Training Periodization

Apollo automatically detects which training phase you're in and adapts its coaching accordingly.

**Phase detection algorithm:**
- Analyzes your plan week-by-week: total mileage, quality workout ratio, and proximity to race day
- Identifies five phases: **Base** (aerobic foundation), **Build** (quality workout introduction), **Peak** (highest volume), **Taper** (controlled reduction), and **Race** (race week)
- Detects phase transitions with contextual messages (e.g., "You've moved from Peak to Taper — volume drops are intentional")

**Phase-aware coaching:**
- 4–5 coaching tips per phase, prioritized by importance
- Base phase: "Keep all runs conversational" · "Build weekly mileage by no more than 10%"
- Build phase: "One quality session per week is enough" · "Easy days should feel genuinely easy"
- Peak phase: "This is your highest-volume week — trust the process" · "Sleep and recovery are training"
- Taper phase: "Reduced volume is not losing fitness" · "Maintain intensity, cut volume"
- Race phase: "Nothing new on race day" · "Trust your training — the work is done"

**How it works:**
- Finds the race week (last week with a marathon/race day)
- Works backward: taper = weeks where mileage drops ≥20% from peak
- Peak = weeks at ≥90% of maximum mileage
- Build/base split at the point where quality workouts are introduced
- Results cached via persistence for instant access

---

## Performance Management Chart (PMC)

A full CTL/ATL/TSB fitness-fatigue model — the same chart used by professional coaches in TrainingPeaks, built from your synced and imported runs (cross-training load can be included).

**Core metrics:**
- **CTL** (Chronic Training Load) — 42-day exponential moving average of daily TSS. Your "fitness."
- **ATL** (Acute Training Load) — 7-day EMA. Your "fatigue."
- **TSB** (Training Stress Balance) — CTL minus ATL. Your "form" or readiness.

**TSB zone classification:**
| Zone | TSB Range | Meaning |
|------|-----------|---------|
| Overreaching | < −20 | High fatigue risk — back off |
| Productive | −20 to 0 | Hard training, building fitness |
| Fresh | 0 to 15 | Recovered, ready for quality work |
| Peak | 15 to 25 | Ideal for racing |
| Transition | 25 to 30 | Losing sharpness |
| Detrained | > 30 | Extended break — fitness declining |

**Features:**
- Activity-to-TSS conversion using distance, duration, elevation, and heart rate
- Workout type classification (recovery / easy / moderate / hard / race)
- Auto-generated annotations for key events (CTL peak, TSB extremes, taper start/end, race day)
- Forward projection: simulate future CTL/ATL/TSB with configurable average daily TSS
- Readiness score (0–100) derived from TSB and CTL, with human-readable labels
- Insights: peak fitness date, current zone, freshness trajectory, and actionable advice

---

## Running Economy Tracker

Track your aerobic efficiency over time — a leading indicator of fitness gains and an early warning system for overtraining.

**Economy Index:**
- Calculated as `(speed m/min ÷ average HR) × 100`
- Higher values = more efficient (faster at the same heart rate)
- Filtered to easy runs only (< 75% max HR, ≤ 9 miles) for apples-to-apples comparison

**What it tracks:**
- Per-run economy data points with date, pace, HR, and run type classification
- 30-day rolling trend with improvement percentage and direction (improving / stable / declining)
- Personal best economy index with date
- Decline detection: consecutive weeks of declining average economy flagged as a potential overtraining signal (2+ weeks triggers a warning)

**Insights generated:**
- Overall trend direction and percentage change
- Proximity to personal best economy
- Decline warnings when 2+ consecutive weeks show declining efficiency
- Context-aware messages based on data volume

---

## Structured Workouts & VDOT Pacing

Every workout in your plan includes VDOT-calculated pace targets based on Jack Daniels' methodology.

- **Pace zones:** Easy, Marathon, Tempo, Interval, Repetition — each with per-mile and per-km targets
- **Dynamic recalculation:** Paces update as your VDOT improves through training
- **Workout compliance analysis:** Tracks whether you're hitting prescribed paces with grade-based feedback
- **Structured workout types:** Easy runs, long runs, tempo runs, interval sessions, and repetition work — each with specific warm-up and cool-down guidance

---

## Training Journal & Shoe Tracking

### Training Journal

Rich training journal with mood tracking, effort ratings, and full-text search.

- **Per-run entries:** Notes, mood (1-5), perceived effort (1-10), tags (weather, terrain, etc.)
- **Searchable history:** Full-text search across all journal entries
- **Calendar integration:** Journal entries linked to training days and synced activities

### Shoe Tracking

- **Shoe inventory:** Track multiple pairs with name, brand, model, and purchase date
- **Mileage tracking:** Automatic mileage accumulation from synced activities
- **Rotation alerts:** Notifications when a shoe approaches retirement mileage (default 400 mi)
- **Active/retired status:** Archive shoes without losing history

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

Use any combination of these — or none at all. Everything except Strava is free.

| Source | Cost | What you get |
|--------|------|--------------|
| **[intervals.icu](https://intervals.icu)** *(recommended)* | Free | Automatic sync of runs, rides, swims, and strength from Garmin, COROS, Suunto, Polar, Wahoo, Zwift, and more — plus sleep, HRV, and resting HR for the recovery check, and plan delivery to your watch |
| **File & archive import** | Free, no account | FIT, GPX, TCX (and `.gz`), Garmin Connect data export, Strava bulk export |
| **Strava** | Requires Strava API access | OAuth sync of activities, splits, and laps |
| **Open-Meteo** | Free, no key | Weather forecasts and heat-adjusted predictions (opt-in) |

### intervals.icu (free — recommended)

intervals.icu is a free training platform that connects directly to Garmin Connect, COROS, Suunto, Polar, Wahoo, Zwift, and others. Apollo uses it as a free hub: your watch syncs to intervals.icu, and Apollo syncs from intervals.icu — no Strava subscription, no developer approval, no server.

**Setup (about two minutes):**
1. Create a free account at [intervals.icu](https://intervals.icu) and connect your watch or platform under **Settings → Connections**. To receive Apollo's plan on your watch, tick **Upload planned workouts** on that device's box.
2. In intervals.icu, open **Settings → Developer Settings** and copy your **API key** (your athlete ID, e.g. `i12345`, is optional).
3. In Apollo, open **Settings → intervals.icu**, paste the key, and click **Connect**.

Apollo verifies the key, stores it encrypted (OS keychain on desktop), turns on auto-sync, and imports your full history. After that, every sync fetches only new and recently edited activities.

**What Apollo fetches:** every activity type with distance, moving time, pace/speed, elevation, heart rate (average + max), cadence, power (average + normalized), training load, and indoor/trainer flags — plus GPS routes and per-mile/km splits from the activity streams. It also reads your **wellness** data (sleep, resting HR, HRV, and anything you log such as fatigue or soreness — up to a year back, then the last week on every sync) for the [Daily Recovery Check](#daily-recovery-check), and your **run settings** (max HR, LTHR, threshold pace). To get wellness data, let your watch or ring send it to intervals.icu (for Garmin, enable wellness data on the Garmin connection in intervals.icu → Settings → Connections).

> [!NOTE]
> Activities that reached intervals.icu *from Strava* aren't exposed through intervals.icu's API (a Strava licensing restriction). Connect your watch to intervals.icu directly, or import your Strava export ZIP once to bring in that history.

### Workouts to Your Watch

Apollo writes your training plan into your intervals.icu calendar as structured workouts, and intervals.icu delivers them to your watch. Use the **Send your plan to your watch** card on the Training page (also in Settings):

- **Structured steps with your paces** — warm-up, repeats with recovery jogs, tempo and marathon-pace segments, cool-down, with pace ranges from your VDOT (race prediction first, then your saved training paces), written in intervals.icu's workout syntax. Until Apollo knows your paces, workouts go out as plain distances
- **Delivered to your device** — intervals.icu uploads planned workouts to Garmin, COROS, Suunto, and Wahoo watches once you tick **Upload planned workouts** on your device's box in intervals.icu → Settings → Connections
- **Safe to re-push** — every workout carries a stable Apollo ID, so sending again updates existing entries instead of duplicating them. Outdated Apollo workouts (plan switched, start date moved) are removed; past days and anything you created yourself are never touched, and **Remove Apollo workouts** deletes only Apollo's upcoming workouts
- **Auto-update (optional)** — when your plan, paces, or units change, Apollo re-sends the next 4 weeks. It checks after every sync, at launch, and when Apollo regains focus, and only calls intervals.icu when something changed (or once a day)

> [!TIP]
> **Garmin:** the watch only shows pace targets when a **Run threshold pace** is set in intervals.icu (Settings → Sport settings) — Apollo checks this and warns you on the card if it's missing. If you set it after sending, click **Remove Apollo workouts** and send again so Garmin receives fresh copies. Zwift only receives rides, so Apollo's run workouts won't appear there.

### File & Archive Import (no account needed)

| Input | Details |
|-------|---------|
| `.fit` | Garmin, COROS, Suunto, Wahoo, Zwift, and more — sessions, laps, GPS, heart rate, cadence, power |
| `.gpx` | GPS tracks, including heart rate and cadence extensions |
| `.tcx` | Laps, GPS, heart rate, cadence, power |
| `.gz` | Any of the above, gzipped (as found in Strava exports) |
| `.zip` | A Garmin Connect *Export Your Data* archive or a Strava bulk export (names and sport types come from `activities.csv`); nested archives are handled |

**Getting your files:**
- **Garmin Connect** — Account Settings → Data Management → *Export Your Data* (you'll receive a ZIP by email). For a single activity: open it in Garmin Connect → ⚙ → *Export Original*.
- **Strava** — Settings → My Account → *Download or Delete Your Account* → *Request your archive*.

**Where:** the **Import files** button on the Activities page, or the *Import activity files* card in Settings → Data sources. Drop files, whole folders, or the export ZIP exactly as you downloaded it — or click *Choose files*.

Files are parsed entirely on your device — nothing is uploaded anywhere. The import keeps running if you switch pages, and you can cancel at any time without losing what was already read. Re-importing is safe: duplicates are detected by start time and distance and merged with any copy already synced from intervals.icu or Strava. Imported runs are matched to your plan immediately, even offline. Apollo keeps your 5,000 most recent activities on the device (more than 13 years of daily runs) and tells you if an import goes past that.

### Strava (optional)

Strava API access is no longer freely available to every athlete. If your account has it, Apollo supports full OAuth2 sync on both platforms:

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

If you connect both Strava and intervals.icu, activities are de-duplicated automatically.

### Garmin Devices

Garmin's official Connect APIs are limited to approved business partners, so Apollo reaches Garmin the free way: automatically through intervals.icu (Garmin Connect → intervals.icu → Apollo, and planned workouts back to the watch), or manually by importing FIT files or your Garmin data export.

---

## Security & Privacy

Apollo is built with a security-first mindset. Every layer of the stack — from Electron's main process to the persistence layer — is hardened against common attack vectors.

### Data Privacy

- **100% offline-capable** — all data lives in localStorage + IndexedDB on your machine
- **No telemetry** — Apollo collects zero analytics, usage data, or crash reports
- **No cloud accounts** — no login, no email, no phone number
- **Every data connection is opt-in** — intervals.icu and Strava are optional; file import is parsed entirely on your device and works offline
- **Health data stays local** — sleep, HRV, and resting-HR records synced from intervals.icu are stored only on your device (about the last 400 days) and are never sent anywhere else; switch the sync off any time in Settings
- **Writes only what it owns** — sending your plan to the intervals.icu calendar creates, updates, and removes only events tagged with Apollo's own ID; your other workouts, notes, and past days are never modified
- **Weather is opt-in** — Open-Meteo is free and requires no API key or account

### Credential Security (Desktop)

- **OS-level encryption** — your intervals.icu API key and Strava credentials/tokens are encrypted via Electron's `safeStorage` API (DPAPI on Windows, Keychain on macOS, libsecret on Linux)
- **Encrypted-at-rest** — credentials stored as Base64 AES blobs in a JSON file in the app's userData directory, never in localStorage or IndexedDB
- **Key allowlisting** — IPC handlers only accept a fixed set of credential keys (`intervals_credentials`, `strava_tokens`, `strava_credentials`, and the reserved `garmin_*` keys). Arbitrary key names are rejected.
- **Web fallback** — on the web platform (no OS keychain), tokens are stored in persistence with a warning, and client secrets are routed through the Azure Functions BFF

### Electron Hardening

| Protection | Status |
|-----------|--------|
| `contextIsolation` | ✅ Enabled — renderer cannot access Node.js |
| `nodeIntegration` | ✅ Disabled |
| `webSecurity` | ✅ Always enabled (production and development) |
| `webviewTag` | ✅ Disabled |
| `nodeIntegrationInWorker` | ✅ Disabled |
| `will-navigate` guard | ✅ Only allows `localhost:5173` and `file:` origins |
| `setWindowOpenHandler` | ✅ All new windows denied; HTTPS URLs opened in OS browser |
| `open-external` allowlist | ✅ HTTPS only, and only `intervals.icu`, `strava.com`, and `connect.garmin.com` |
| DevTools | ✅ Only in development builds |

### Web Security

- **Content Security Policy** — strict CSP in `staticwebapp.config.json`: `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `connect-src` limited to intervals.icu, Strava, Garmin, and Open-Meteo
- **X-Frame-Options** — `DENY`
- **X-Content-Type-Options** — `nosniff`
- **Referrer-Policy** — `strict-origin-when-cross-origin`
- **Permissions-Policy** — camera, microphone, and geolocation all disabled

### Application Security

| Vector | Protection |
|--------|-----------|
| XSS | React JSX auto-escaping; zero `dangerouslySetInnerHTML`; dedicated `esc()` HTML encoder for race card; Blob URL pattern for print windows |
| Code injection | Zero `eval()`, `new Function()`, `setTimeout(string)`, or `child_process` usage |
| SSRF | All external URLs hardcoded (`api.open-meteo.com`, `intervals.icu`, `strava.com`); no user-controlled URL construction |
| Prototype pollution | No `Object.assign` with unvalidated external data; no `__proto__` access |
| OAuth CSRF | Cryptographic state parameter (32 random bytes) validated on callback; single-use |
| Token refresh | Mutex-protected to prevent concurrent refresh races |
| API rate limiting | Strava rate limits tracked via response headers with configurable buffer; intervals.icu requests time out after 30 s and back off on 429/5xx |
| Backup integrity | SHA-256 checksums with read-back verification; tamper detection on restore |
| Backup restore | 10 MB file limit, 1 MB per-key limit, `apollo_*` key allowlist, credential keys excluded, safety backup before every import |
| Activity file import | Parsed on-device by Apollo's own decoders (no third-party parsers); 512 MB per activity file, 1 GB per nested archive, at most 2 levels of nesting; decompression stops at each entry's declared size (zip-bomb guard) and every ZIP entry is CRC-32 verified |
| Coordinate validation | Latitude/longitude bounds-checked before API calls |
| ReDoS | No user-input regex patterns; all regex is simple literals |
| Hardcoded secrets | Zero — all credentials from `process.env`, OS keychain, or user input at runtime |

---

## Your Training Playbook

A guide to getting the most out of Apollo across your training block.

### Week 1 — Getting Started

1. **Launch Apollo** and complete the onboarding — choose a plan, set your start date, pick units, configure coaching
2. **Connect intervals.icu** in Settings (free — link your Garmin, COROS, Suunto, Polar, Wahoo, or Zwift account to intervals.icu first), or **import your files/export** if you'd rather not use any account. Strava works too if you have API access
3. **Send your plan to your watch** (optional) — push it to your intervals.icu calendar and today's workout appears on your device
4. **Run your first planned workout** and record it on your watch as usual
5. **Open Apollo** — your run syncs automatically, your day is marked complete, and you receive your first coaching feedback

### Every Run Day

1. Check the **Training Calendar** for today's workout (or just start it from your watch)
2. Run and record as usual (GPS + heart rate for the richest insights)
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

Apollo is configured for Azure Static Web Apps with an Azure Functions API backend for Strava OAuth. The backend is only needed for the optional Strava connection — intervals.icu sync, plan push, and file import run entirely in the browser, so steps 1 and 4 can be skipped if you don't use Strava.

### 1. Create a Strava App *(optional)*

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

**1,431 tests** across **55 test files**, all passing:

| Test File | Tests | Coverage Area |
|-----------|-------|--------------|
| fileImportFit | 80 | FIT decoding: records, laps, sessions, developer fields, compressed timestamps |
| edgeCaseStress | 79 | Boundary conditions, extreme inputs, stress testing across all services |
| scientificValidation | 76 | Peer-reviewed formula validation, physiological model accuracy |
| plans | 64 | Plan library, custom builder, recommendation engine, day assignments |
| pmcChart | 47 | TSB zones, workout classification, daily loads, CTL/ATL/TSB, projections |
| fileImportArchive | 44 | ZIP/ZIP64 reading, nested archives, gzip, deflate fallback |
| effortService | 43 | Route fingerprinting, tier ranking, insight generation |
| splitService | 43 | Split processing, consistency grading, pattern detection |
| raceCard | 42 | Race card generation, pace bands, HTML output, preferences |
| routeService | 41 | Polyline decoding, projection, haversine, bearing, caching |
| unitPreferences | 41 | Unit conversion, formatting, distance/pace/elevation |
| intervals | 40 | intervals.icu mapping, IDs, paging, athlete, routes, detail, calendar events, wellness |
| planCalendarSync | 39 | Plan → intervals.icu workout text, idempotent push/remove, auto-update |
| wellness | 35 | Wellness sync (sleep, HRV, resting HR), HR profile updates, recovery status, threshold pace |
| periodization | 34 | Week analysis, phase detection, coaching tips, persistence |
| raceStrategy | 32 | Strategy building, pacing, elevation adjustment, time-based gel timing, persistence |
| runningEconomy | 30 | Economy index, run classification, trends, decline detection |
| shoeTracker | 30 | Shoe CRUD, mileage tracking, rotation, retirement alerts |
| autoSync | 28 | Activity matching, mileage tracking, pace classification |
| fileImportBuild | 28 | Parsed file → activity mapping, IDs, splits, polylines |
| raceChecklist | 28 | Checklist CRUD, course templates, progress tracking |
| trainingJournal | 28 | Journal entries, mood/effort tracking, search |
| weather | 28 | Heat adjustment, risk levels, forecast caching, coordinate validation |
| backupService | 27 | Create, restore, verify, import, export, health monitoring |
| complianceAnalysis | 27 | Workout compliance, grade accuracy, feedback generation |
| paceCalculator | 24 | VDOT pace zones, pace formatting, training paces |
| workoutTargets | 23 | Structured workout generation, interval blocks |
| racePrediction | 20 | VDOT, Riegel, blending, confidence scoring |
| postRaceAnalysis | 19 | Mile comparison, grading, insights, report management |
| calendarExport | 18 | ICS generation, event creation, duration estimation |
| activityHelpers | 17 | Sport classification, polyline encoding, decimation, split derivation |
| taperOptimizer | 17 | CTL/ATL/TSB modeling, taper plan generation |
| activityDedupe | 16 | Cross-source de-duplication, source priority, field merging, 5,000-activity store cap |
| adaptiveTraining | 15 | Preference persistence, recommendation lifecycle |
| fileImportXml | 15 | GPX/TCX parsing, extensions, namespaces, malformed input |
| storage | 15 | Token/credential storage, intervals.icu credentials, keychain-failure handling, web-mode guards |
| fileImport | 14 | End-to-end import pipeline, Strava/Garmin exports, de-duplication, progress |
| raceDayTimeline | 14 | Race morning schedule, event timing, carb targets |
| activitySource | 13 | intervals.icu connect flow, athlete IDs, external links, full + incremental sync |
| aerobicDecoupling | 13 | Cardiac drift, Friel thresholds, decoupling calculation |
| fileImportJob | 13 | App-wide import job: progress throttling, cancel, folder drops, result messages |
| bonkRisk | 12 | 7-factor risk scoring, factor weighting |
| courseTraining | 11 | World Major training plans, generic recommendations |
| ghostRunner | 11 | Mile comparison, cumulative delta, trend analysis |
| raceEquivalence | 11 | Temperature, altitude, wind, humidity normalization |
| hydrationCalculator | 10 | Sweat rate, sex adjustment, aid station planning |
| whatIfSimulator | 10 | Scenario projections, VDOT calibration |
| carbLoading | 9 | 3-day protocol, meal targets, body weight scaling |
| crossTraining | 9 | Cross-training load estimates, per-sport summaries, weekly volume |
| fatigueResistance | 9 | FRI calculation, anomalous split filtering |
| fuelingCalculator | 9 | Carb rate, gel timing, caffeine dosing |
| glycogenModel | 9 | Glycogen depletion, substrate crossover, fueling impact |
| weeklyReadiness | 9 | Letter grading, boundary values, monotonic ordering |
| pacingDecay | 7 | Decay curves, race projection, gap analysis |
| dailyRecap | 5 | Daily grading, coach messages from journal or watch sleep (TDZ regression) |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18, TypeScript 5 (strict), Vite 7, React Router 6 |
| **Desktop** | Electron 40 with secure preload IPC, safeStorage credential encryption |
| **Charts** | Recharts 3 (analytics) + custom pure SVG (routes, splits, gauges) |
| **Persistence** | localStorage + IndexedDB via Dexie 4 — dual-write, auto-hydration |
| **Web API** | Azure Functions (Node) for the optional Strava OAuth token exchange |
| **Integrations** | intervals.icu REST API (free — activities, streams, wellness, sport settings, calendar events), Strava API v3 (optional — OAuth2, rate-limited, mutex-protected refresh), dependency-free FIT/GPX/TCX/ZIP parsing, Open-Meteo (weather) |
| **Testing** | Vitest 4 with jsdom, 1,431 tests across 55 files, v8 coverage |
| **Security** | CSP headers, navigation guards, IPC key allowlisting, SHA-256 backup verification |
| **Design** | Art Deco system — navy `#0D1B2A` + gold `#D4A537`, Montserrat / Inter / JetBrains Mono |

---

## Project Structure

```
src/
├── pages/                  Seven app pages + auth callback + 404
│   ├── Dashboard.tsx         Home — today's quest, stats, recaps, recommendations
│   ├── Training.tsx          Plan tracking — calendar + checklist + auto-sync + send to watch
│   ├── Activities.tsx        Activity history — runs + cross-training, sport filters, file import, splits
│   ├── Analytics.tsx         Charts — mileage, pace, load, HR, consistency, PRs
│   ├── Insights.tsx          Coaching — predictions, readiness, recaps, HR zones
│   ├── RaceStrategy.tsx      Race pacing — marathon browser, strategy builder, imports
│   ├── Settings.tsx          Config — data sources (intervals.icu, files, Strava), units, coaching, auto-sync, updates, backups
│   └── WelcomeFlow.tsx       Guided onboarding wizard (9 steps)
│
├── components/
│   ├── CalendarView.tsx      Monthly training calendar with day detail panel
│   ├── RouteMap.tsx          Pure SVG route visualization (thumbnail/card/detail)
│   ├── SplitAnalysis.tsx     Pace charts, split tables, consistency grading
│   ├── AdaptiveRecommendations.tsx  Coaching recommendation cards
│   ├── TierBadge.tsx         Gold/Silver/Bronze achievement badges
│   ├── ConnectDataSourceCTA.tsx  "Connect intervals.icu or import files" prompt
│   ├── ImportActivities.tsx  Drag-and-drop FIT/GPX/TCX/ZIP import with progress
│   ├── PlanCalendarPush.tsx  "Send your plan to your watch" (intervals.icu calendar)
│   ├── RecoveryCard.tsx      Daily recovery check — sleep, resting HR, HRV vs your baselines
│   ├── PlanBuilder.tsx       Custom plan builder
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
│   ├── activitySource.ts     Sync engine — every connected source, full/incremental sync, events
│   ├── intervals.ts          intervals.icu API client (activities, streams, wellness, calendar events)
│   ├── planCalendarSync.ts   Plan → intervals.icu structured workouts (push, auto-update, remove)
│   ├── wellness.ts           Sleep/HRV/resting-HR sync, recovery snapshot, threshold-pace check
│   ├── crossTraining.ts      Cross-training load estimates and summaries
│   ├── activity/
│   │   ├── types.ts            Source-neutral Activity model
│   │   ├── sports.ts           Sport categories (run / ride / swim / strength / other)
│   │   ├── streams.ts          Stream → route polyline + split derivation
│   │   └── dedupe.ts           Cross-source duplicate detection and merging
│   ├── fileImport/
│   │   ├── index.ts            importActivityFiles() — formats, archives, batching, progress
│   │   ├── fit.ts              Dependency-free FIT decoder
│   │   ├── gpx.ts / tcx.ts     GPX and TCX parsers
│   │   ├── xml.ts              Minimal XML reader (no DOMParser needed)
│   │   ├── archive.ts          Random-access ZIP reader, Strava CSV + Garmin summary parsing
│   │   ├── inflate.ts          DEFLATE / gzip decoder
│   │   ├── build.ts            Parsed file → Activity (splits, laps, route, sport)
│   │   └── types.ts            Shared parser types and errors
│   ├── autoSync.ts           Plan matching (runs + cross-training) + feedback generation
│   ├── routeService.ts       Polyline decoding, projection, caching
│   ├── effortService.ts      Route fingerprinting + effort ranking + insights
│   ├── splitService.ts       Split/lap processing + consistency analysis
│   ├── analyticsService.ts   Stats aggregation, charts data, PRs, streaks, merge-aware store
│   ├── racePrediction.ts     VDOT + Riegel race time predictions
│   ├── weeklyReadiness.ts    5-factor readiness scoring
│   ├── adaptiveTraining.ts   Training pattern detection + recommendations
│   ├── dailyRecap.ts         Daily grade + coach messaging
│   ├── heartRate.ts          HR zones, distribution, trends, efficiency
│   ├── backupService.ts      Automatic backups with SHA-256 verification
│   ├── raceStrategy.ts        Strategy building, pacing, custom imports, persistence
│   ├── glycogenModel.ts       Mile-by-mile glycogen depletion simulation
│   ├── hydrationCalculator.ts  Sweat rate modeling and hydration planning
│   ├── carbLoading.ts         3-day carb loading protocol generator
│   ├── fuelingCalculator.ts   In-race fueling plan with caffeine strategy
│   ├── whatIfSimulator.ts     What-if scenario projections
│   ├── fatigueResistance.ts   Fatigue Resistance Index calculation
│   ├── pacingDecay.ts         Pacing decay curve modeling
│   ├── raceEquivalence.ts     Weather/altitude race time normalization
│   ├── aerobicDecoupling.ts   Cardiac drift analysis
│   ├── ghostRunner.ts         Mile-by-mile run comparison
│   ├── raceDayTimeline.ts     Race morning schedule generator
│   ├── courseTraining.ts      World Major-specific training plans
│   ├── taperOptimizer.ts      Banister CTL/ATL/TSB taper planning
│   ├── bonkRisk.ts            7-factor bonk risk assessment
│   ├── paceCalculator.ts      VDOT pace zone calculator
│   ├── workoutTargets.ts      Structured workout generation
│   ├── complianceAnalysis.ts  Workout compliance tracking
│   ├── trainingJournal.ts     Training journal with mood/effort
│   ├── shoeTracker.ts         Shoe mileage tracking and rotation
│   ├── weather.ts             Open-Meteo weather forecasting + heat modeling
│   ├── calendarExport.ts      .ics calendar export with VDOT paces
│   ├── raceChecklist.ts       Pre-race checklists with course templates
│   ├── postRaceAnalysis.ts    Actual vs planned race comparison + grading
│   ├── raceCard.ts            Printable one-page race day companion
│   ├── periodization.ts       Training phase detection + coaching tips
│   ├── pmcChart.ts            CTL/ATL/TSB performance management chart
│   ├── runningEconomy.ts      Pace:HR efficiency tracking + decline detection
│   ├── appPreferences.ts     Auto-sync and auto-update preferences
│   ├── coachingPreferences.ts  Scheduling and notification settings
│   ├── unitPreferences.ts    Miles/km toggle + all conversion helpers
│   ├── strava.ts             Strava API client (optional; rate-limited, mutex refresh)
│   ├── stravaWeb.ts          Web-mode Strava OAuth helpers
│   ├── garmin.ts             Garmin Connect API placeholder (needs Garmin developer approval)
│   ├── storage.ts            Cross-platform token/credential management (OS keychain on desktop)
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
│   ├── journal.ts            Training journal entry types
│   ├── workout.ts            Workout target, interval block, HR zone types
│   ├── nutrition.ts          Race conditions, athlete profile, fueling plan types
│   ├── shoes.ts              Shoe, shoe status, usage types
│   └── raceStrategy.ts       Marathon, strategy, pacing, elevation types
│
└── __tests__/                1,431 tests across 55 files
    └── setup.ts              Test harness with in-memory persistence mock

electron/                     Electron main process + secure preload
api/                          Azure Functions (Strava token exchange)
public/                       Static assets, PWA manifest, SWA config
```

---

## License

MIT © Marc Copeland
