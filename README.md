<p align="center">
  <img src="public/assets/logo-1024.png" alt="Apollo" width="140" />
</p>

<h1 align="center">Apollo</h1>

<p align="center">
  <strong>The definitive marathon training platform.</strong><br />
  Smart plans · Direct Garmin Connect sync · Free sync via intervals.icu · FIT/GPX/TCX and export import · Workouts to your watch · Race-day pacing and fueling<br />
  <em>Local-first. Zero subscriptions. No Apollo account, no Apollo servers — your data stays on your device.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/app%20tests-~2000%20passing-brightgreen" alt="About 2,000 app tests passing" />
  <img src="https://img.shields.io/badge/typescript-strict-blue" alt="TypeScript strict" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" />
  <img src="https://img.shields.io/badge/platform-desktop%20%7C%20web-gold" alt="Desktop & Web" />
</p>

---

## Table of Contents

- [Why Apollo](#why-apollo)
- [Download & Install](#download--install)
- [What's New in v1.0.8](#whats-new-in-v108)
- [Features at a Glance](#features-at-a-glance)
- [The Training Calendar](#the-training-calendar)
- [How the App Works — Page by Page](#how-the-app-works--page-by-page)
  - [Today](#-today)
  - [Plan](#-plan)
  - [Activities](#-activities)
  - [Progress](#-progress)
  - [Race Day](#-race-day)
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
- [Race Fueling](#race-fueling)
  - [Carb Loading](#carb-loading)
  - [In-Race Fueling](#in-race-fueling)
  - [Hydration and Sweat Test](#hydration-and-sweat-test)
  - [Caffeine (optional)](#caffeine-optional)
- [Race Morning & Course Training](#race-morning--course-training)
  - [Race Morning Timeline](#race-morning-timeline)
  - [Course-Specific Training](#course-specific-training)
- [Calendar Export](#calendar-export)
- [Race Week Checklist](#race-week-checklist)
- [Printable Race Card](#printable-race-card)
- [Training Periodization](#training-periodization)
- [Fitness & Form Chart (PMC)](#fitness--form-chart-pmc)
- [Structured Workouts & VDOT Pacing](#structured-workouts--vdot-pacing)
- [Data Safety & Backups](#data-safety--backups)
- [Integrations](#integrations)
  - [Garmin Connect (direct)](#garmin-connect-direct--desktop-app)
  - [intervals.icu](#intervalsicu-free--recommended)
  - [Workouts to Your Watch](#workouts-to-your-watch)
  - [File & Archive Import](#file--archive-import-no-account-needed)
  - [Strava (optional)](#strava-optional)
- [Security & Privacy](#security--privacy)
- [Your Training Playbook](#your-training-playbook)
- [Experimental (not in the app yet)](#experimental-not-in-the-app-yet)
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

- **Free sync with every major platform** — Connect **Garmin Connect** directly with your own free personal API key (desktop app): every activity, with routes, splits and laps from your watch's original files, and no other account in between. Or connect a free [intervals.icu](https://intervals.icu) account and Apollo pulls every run, ride, and swim recorded on COROS, Suunto, Polar, Wahoo, Zwift, and more — full history on the first sync, incremental after that. Prefer zero accounts? Drag in FIT/GPX/TCX files or your whole Garmin/Strava data export. Strava's paid API is supported too, but never required.
- **Your plan on your wrist** — Push your training plan to the intervals.icu calendar with VDOT-calibrated paces, and intervals.icu delivers each structured workout to your Garmin, COROS, Suunto, or Wahoo watch.
- **Recovery that reads your watch** — Turn on wellness sync and sleep, HRV, and resting heart rate come free from intervals.icu into a daily recovery check that compares today against *your* normal ranges and tells you when to back off.
- **Plans based on the methods you know** — Hal Higdon, Hansons, Pfitzinger, Nike Run Club and FIRST. Each plan says how closely it follows the coach's published plan and links to the official source. Apollo is independent and not endorsed by any of them. Or build your own from scratch with the custom plan builder. Joining late? Apollo checks the week you'd join against your recent running and suggests a gentler plan or a later race if it's a big jump.
- **Race-day fueling you can follow** — A carb-loading plan (Burke 2011), an in-race carb plan within 20–90 g/h (Jeukendrup 2014), a fluid ceiling from your own sweat test, and an optional caffeine card (Goldstein 2010), all on the Race Day › Fuel tab.
- **Coaching that explains itself** — Race predictions from your recent races (Daniels VDOT and Riegel). Adaptive recommendations you can apply and undo. Automatic training-phase detection, and a fitness & form chart (CTL/ATL/TSB) that shows your projected race-morning form.
- **Race day as a system, not a hope** — Mile-by-mile pacing for six of the seven World Marathon Majors (Sydney coming) or any race you add, a race-morning timeline, course-specific training tips, a race-week checklist, and a printable race card.
- **Export your plan anywhere** — One-click .ics calendar export with VDOT-paced workout descriptions. Works with Google Calendar, Outlook, and Apple Calendar.
- **Every run tells a richer story** — Route maps rendered as Art Deco artwork. Split-level pacing breakdowns. Effort recognition that remembers every time you've run that neighborhood loop and tells you exactly how today compared.
- **Your data, your device** — localStorage + IndexedDB. Automatic backups checked after they're written (SHA-256), and a **Not saved** banner if a save ever fails. Export everything as JSON. Nothing leaves your machine unless you connect a service.
- **Security-hardened** — OS-level credential encryption via Electron's safeStorage API, Content Security Policy headers, navigation guards, IPC key allowlisting, a read-only allow-listed proxy for Garmin Connect, coordinate validation, and HTML entity escaping. Zero `eval()`, zero `dangerouslySetInnerHTML`, zero hardcoded secrets.
- **About 2,000 app tests** — Plans, paces, sync (Garmin Connect, intervals.icu, Strava), file import, backups and screens. Key formulas (Daniels VDOT, Riegel, CTL/ATL/TSB, carb and fluid targets) are checked against values from their published sources. Apollo gives training guidance, not medical advice.

---

## Download & Install

**No coding needed.** Download the installer for your computer from the **[latest release](https://github.com/LetsLearntocodeforfun/Apollo-Running/releases/latest)**:

| Your computer | File to download |
|---|---|
| Windows 10/11 | `Apollo-Setup-<version>.exe` |
| Mac with Apple Silicon (M1 and later) | `Apollo-<version>-arm64.dmg` |
| Mac with an Intel chip | `Apollo-<version>.dmg` |
| Linux (any distribution) | `Apollo-<version>.AppImage` |
| Debian / Ubuntu | `apollo-marathon_<version>_amd64.deb` |

**Don't want to install anything?** [Use it in your browser](docs/INSTALL.md#use-it-in-your-browser) at **https://letslearntocodeforfun.github.io/Apollo-Running/** (live after the first deploy). Your data stays in that browser, and Strava and Garmin Connect sync are desktop-only.

The first time you open Apollo, your computer asks you to confirm once. That's because the installers aren't signed with a paid publisher certificate yet:

- **Windows:** *More info → Run anyway*.
- **macOS 15+:** *System Settings → Privacy & Security → Open Anyway*.
- **macOS 14 and earlier:** *Control-click → Open*.

**[Step-by-step install guide →](docs/INSTALL.md)**

Every release includes `SHA256SUMS.txt` and GitHub build-provenance attestations, so you can check that your download is genuine. Why the prompt appears, and the free signing routes we're pursuing: [docs/SIGNING.md](docs/SIGNING.md).

Apollo's guided onboarding then walks you through choosing a plan, setting your race date, picking your units and setting coaching preferences. To bring in your runs (directly from Garmin Connect with a free personal API key, free via intervals.icu, by importing files or exports, or via Strava if you have API access), see [Integrations](#integrations).

### Run from source (developers)

```bash
git clone https://github.com/LetsLearntocodeforfun/Apollo-Running.git
cd Apollo-Running
npm ci
npm run dev            # browser: http://localhost:5173
npm run dev:electron   # desktop app
```

Requires Node.js 22 or later.

---

## What's New in v1.0.8

**Direct Garmin Connect sync (desktop app).** Garmin now lets every Garmin Connect user create a free personal API key for their own data. Paste yours in **Settings › Connections › Garmin Connect** and Apollo imports your history straight from Garmin, with no intervals.icu or Strava account in between. [How to connect →](#garmin-connect-direct--desktop-app)

- **Every sport, with the details** — runs, rides, swims and everything else; routes, per-mile/km splits, laps and best efforts come from your watch's original FIT files.
- **One copy of each workout** — when the same activity also arrives through intervals.icu, Strava or a file import, Apollo keeps one copy and prefers Garmin's own numbers.
- **Key-expiry reminders** — tell Apollo the expiry you picked (30 days to a year) and it warns you a week before. If Garmin rejects the key, Garmin sync pauses with a *Reconnect needed* banner instead of retrying silently; **Replace key** keeps your history and sync progress.
- **Read-only and locked down** — the key is encrypted on your computer and sent only to Garmin. The app can only make read-only calls to an allow-list of Garmin endpoints.
- **Ready for Garmin's new developer terms** — if intervals.icu stops passing Garmin activities to apps, Apollo keeps the Garmin activities it already has instead of treating them as deleted.

Sending your plan to your watch still goes through intervals.icu (Garmin's personal API is read-only). The browser version can't connect to Garmin (Garmin's API doesn't accept requests from web browsers): import FIT files or a Garmin export there instead.

**Also in this release.** v1.0.7 wasn't published on its own, so its changes ship in v1.0.8:

- **Use it in your browser** — a free web version on GitHub Pages (live after the first deploy). Your data stays in that browser; Strava and Garmin Connect sync are desktop-only. See [the install guide](docs/INSTALL.md#use-it-in-your-browser).
- **Safer saving** — a **Not saved** banner with *Retry* if a write ever fails, backups checked after they're written, and damaged data set aside instead of lost.
- **Plans that follow their coach** — every built-in plan says how closely it follows the published plan and links to the official source. Joining late? A fitness check compares the week you'd join with your recent running.
- **Race Day › Fuel** — an optional caffeine card, a sweat test (and a "salty sweater" option) that sets your fluid and sodium guidance, and one carb ceiling of 20–90 g/h.
- **Charts that don't mislead** — the fitness & form chart shows your projected race-morning form, and heart-rate zones say when time in zone is estimated rather than measured.
- **Privacy** — read-only Strava access, wellness sync off by default for new installs, and saving on close.
- **Security updates** — Electron 44.9.1, plus updated React Router, Vite and Vitest.

Full details are in the [changelog](CHANGELOG.md).

---

## Features at a Glance

| Feature | What It Does |
|---------|-------------|
| **8 marathon plans** | Hal Higdon (4), Hansons, Pfitzinger, Nike, FIRST — each with a fidelity label and official source link — plus a custom plan builder |
| **Late-join fitness check** | Warns when the plan week you'd join is a big jump from your recent running, and offers a gentler plan or a later race |
| **Plan edits** | Move or skip a day, convert it to an easy run or rest day, and restore the original |
| **Direct Garmin Connect sync** | Desktop app: connect with your own free Garmin personal API key — every activity, with routes, splits and laps from the watch's original files, plus key-expiry reminders |
| **Free activity sync** | intervals.icu connection (free) pulls runs, rides, and swims from COROS, Suunto, Polar, Wahoo, Zwift and more — full history, then incremental |
| **File & archive import** | Drag-and-drop FIT, GPX, TCX (and `.gz`), or an entire Garmin/Strava account export ZIP — no account needed |
| **Workouts to your watch** | Push the plan to your intervals.icu calendar with VDOT paces; intervals.icu uploads it to Garmin, COROS, Suunto, and Wahoo watches |
| **Recovery check** | Opt-in wellness sync: sleep, HRV, and resting HR from your watch (via intervals.icu) → daily status and training suggestion |
| **Cross-training** | Rides, swims, strength, and Zwift sessions count toward cross-training days and training load |
| **Training calendar** | Monthly grid with workout types, intensity colors, sync status, click-to-expand day detail |
| **Smart auto-sync** | Matches synced or imported runs to plan days, auto-completes workouts, generates coaching feedback |
| **Route maps** | Pure SVG visualization of every run — offline, no API keys, with animated drawing effects |
| **Effort recognition** | Tracks repeated routes, awards Gold/Silver/Bronze for pace and HR efficiency |
| **Split analysis** | Per-mile/km pacing charts, consistency grading, interval detection, pattern recognition |
| **Race predictions** | Daniels VDOT from your recent races (blended with Riegel) for marathon, half, 10K, and 5K, with a confidence level |
| **Weekly readiness** | 5-factor score (A+ to D) with coaching tips for the week ahead |
| **Daily recaps** | Grade + coach message comparing your actual effort to the plan |
| **Adaptive coaching** | Detects overtraining, schedule gaps, and race week — suggests plan changes you can apply and undo |
| **HR zone analysis** | 5-zone model, distribution chart that says when time in zone is estimated, HR trend, 80/20 guidance |
| **Fitness & form chart** | CTL/ATL/TSB with the race date marked and your projected race-morning form |
| **Training periodization** | Phase ribbon (Base → Build → Peak → Taper → Race) with phase-aware coaching tips |
| **Structured workouts** | VDOT-paced targets for easy, tempo, interval, repetition, and long runs |
| **Data backups** | Automatic SHA-256 checked backups, export/import, one-click restore, and a **Not saved** banner if a save fails |
| **Race strategy** | Grade-adjusted pacing for six of the seven World Marathon Majors (Sydney coming) and any race you add, with elevation charts |
| **Race fueling** | Carb loading, an in-race carb and gel plan (20–90 g/h), hydration from your sweat test, and an optional caffeine card |
| **Race morning timeline** | Alarm, breakfast, travel, warm-up, corral — all timed back from the gun |
| **Course training** | Course-specific preparation tips for the six Majors in Apollo, plus generic hilly/flat advice |
| **Race week checklist** | Default items plus course-specific items; add, hide, and reset |
| **Printable race card** | One-page race companion with splits, fuel cues, pace bands, 5K checkpoints, segment summaries, and mantras |
| **Calendar export** | One-click .ics export with VDOT-paced workout descriptions for Google/Outlook/Apple Calendar |
| **Auto-sync on launch** | Opt-in automatic sync when the app opens, plus optional background re-sync while it's open (default hourly), with a 5-minute cooldown |
| **Auto-updates** | Opt-in update checking, downloading, and installing (desktop) |
| **Units** | Miles or kilometers, °F or °C, kg or lb |
| **Web version** | The same app in your browser; data stays in that browser (Strava and Garmin Connect sync are desktop-only) |

> Some science modules (ghost runner, bonk risk, glycogen and hydration models, what-if, and more) exist in the code but have no screen yet. See [Experimental (not in the app yet)](#experimental-not-in-the-app-yet).

---

## The Training Calendar

The crown jewel of the Plan page. A full monthly calendar view that shows your entire training block at a glance — designed to rival and surpass what you'd find in TrainingPeaks or Strava.

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
- **Coaching feedback** — the coach message generated by auto-sync
- **Mark Complete / Incomplete** button for manual tracking

**Navigation:**
- Month-by-month browsing with ‹ › arrows
- **Today** button for instant jump to the current date
- **Calendar ↔ Checklist** toggle to switch between the visual calendar and the traditional week-by-week accordion

Everything updates live — complete a day, sync a run, and the calendar reflects it immediately.

---

## How the App Works — Page by Page

Apollo has six sections: **Today**, **Plan**, **Activities**, **Progress**, **Race Day**, and **Settings**.

### ◈ Today

Your home base. Everything you need in one view.

- **Greeting and status** with your athlete name and data-source connection status
- **Today's workout** — a hero card with today's planned workout, its pace and heart-rate targets, and (once synced) your actual metrics and coaching feedback
- **Daily recap** and **weekly readiness** — pop-up cards with your training grade, coach message, strengths, and tips
- **Form chip** — today's form, linking to Progress › Fitness & Form
- **Recovery check** — last night's sleep, resting HR, and HRV from your watch (via intervals.icu, with wellness sync on), with a daily status (*Recovered / OK / Caution*) and a one-line suggestion such as "keep today easy"
- **This week** — distance vs plan, plan progress, adherence, and readiness grade
- **Marathon prediction**
- **Adaptive recommendations** — coaching cards when Apollo detects something actionable (overtraining, schedule gap, race week)
- **Cross-training this week** and **recent activities** with route thumbnails and effort tier indicators

Opening Today syncs when a data source (intervals.icu or Strava) is connected and a plan is active — or, if Apollo synced in the last 10 minutes, simply re-matches what's already on your device. Imported files are matched to the plan the moment they land. No manual action needed.

### ⚡ Plan

Where your plan lives.

- **Plan chooser** — all eight built-in plans as cards, each with its fidelity label, official source link, and the independence notice; or build a custom plan. Set your race date and Apollo places the plan; if the race is close, a fitness check warns when the week you'd join is a big jump and offers gentler plans or a later race
- **Phase ribbon** — base, build, peak, and taper across your block
- **Calendar view** — the monthly training calendar described above
- **Week-by-week checklist** — expandable day rows with checkboxes, dates, workout labels, sync badges, tier badges, route thumbnails, and detailed metrics
- **Day actions** — move or skip a day, convert it to an easy run or rest day, or restore the original (completed days can't be changed)
- **Export** — *Send your plan to your watch* (intervals.icu calendar, as structured workouts with your VDOT paces; optional auto-update keeps the next 4 weeks in step) and a .ics [calendar export](#calendar-export)
- **Smart Auto-Sync card** — manual sync trigger, last sync timestamp, and detailed results for every matched activity

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

### 📈 Progress

Your coaching and analytics hub, in five tabs.

**Overview** — Race prediction (marathon, plus half, 10K, and 5K), race countdown, training adherence with a weekly trend, weekly readiness (what went well, areas to improve, tips for next week), readiness history, and the full [recovery check](#daily-recovery-check).

**Fitness & Form** — The [CTL/ATL/TSB chart](#fitness--form-chart-pmc) with your race date marked and your projected race-morning form.

**Trends** — 7 days, 30 days, 90 days, 6 months, or all time, with summary stats, weekly distance, pace progression, heart-rate efficiency (pace vs HR), cross-training hours by sport, a consistency heatmap, personal records, and recent runs.

**Heart Rate** — Your heart-rate profile, five running zones with BPM ranges, zone distribution for the last 30 days (labelled *estimated* when there's no second-by-second heart rate, with the estimated share shown), and a 30-day HR trend.

**Recaps** — Today's recap with grade, distance vs plan, pace, duration, HR zone, and coach message, plus recent recaps.

### 🏅 Race Day

Plan your race with course-specific pacing, fueling, and logistics. A **My race** card at the top links your race to your plan; five tabs below open on the one that fits how close the race is.

- **Strategy** — browse six of the seven World Marathon Majors (Sydney coming) plus your custom races, pick a target time and pacing strategy, and get a mile-by-mile plan adjusted for elevation, with an interactive elevation chart. See [Race Strategy](#race-strategy)
- **Fuel** — race fueling plan, optional caffeine card, carb loading, and hydration with a sweat test. See [Race Fueling](#race-fueling)
- **Race Week** — the [race week checklist](#race-week-checklist) and the [printable race card](#printable-race-card)
- **Race Morning** — a [timeline](#race-morning-timeline) timed back from the gun
- **Course** — [course-specific training](#course-specific-training)

### ⚙ Settings

Configuration and data management, in six tabs.

- **Connections** — **Garmin Connect (direct, desktop)**: paste your personal API key once; Apollo checks it, encrypts it at rest, imports your full history and reminds you before the key expires. **intervals.icu (free, recommended)**: paste your API key once; Apollo verifies it, encrypts it at rest, and imports your full history. **Import activity files** (FIT/GPX/TCX, optionally `.gz`, or a whole Garmin Connect / Strava export ZIP; duplicates are merged automatically). **Strava (optional, desktop)**: for accounts with Strava API access, with read-only access. If the desktop keychain is unavailable (e.g. Linux without a keyring), Apollo says so instead of silently forgetting the key
- **Sync** — auto-sync on launch plus an optional background re-sync interval (5-minute cooldown), and **wellness data** (sleep, HRV, and resting HR; off by default for new installs) for the Recovery check and your HR profile — it never overrides values you entered yourself
- **Athlete Profile** — units (distance, temperature, body weight), heart rate & body, recent race & goal (used for predictions and paces), and race fueling preferences (caffeine, sweat rate, salty sweater)
- **Coaching** — daily recap and weekly readiness scheduling; adaptive training on/off, frequency, and aggressiveness; training plan options
- **Data & Privacy** — storage and backup health (*Protected / Needs attention / At risk*), automatic and manual backups, export/import as JSON, per-backup download and restore, a list of the services Apollo can contact, any damaged data that was set aside, and *Delete all data*
- **About** — version, opt-in auto-updates on desktop (check, download, install), a note on the web version, and the training plans & coaches notice

---

## Guided Onboarding

On first launch, Apollo walks you through a short setup:

1. **Units** — miles or kilometers
2. **Training plan** — pick a built-in plan (with its fidelity label and source), build a custom plan, or skip for now; set your race date and an optional goal time. If the race is close, the late-join fitness check runs here too
3. **Recent race** *(optional)* — a recent race result sets your VDOT, paces, and prediction
4. **Add your runs** — connect intervals.icu, import files, or decide later
5. **Done** — a summary of your setup, including when week 1 starts; change any of it later in Settings or on the Plan page

You're running in under two minutes.

---

## Built-In Marathon Plans

Eight plans based on well-known coaching methods. Each one says how closely it follows the coach's published plan and links to the official source, so the original is always one click away.

| Plan | Follows | Fidelity | Days/Week | Official source |
|------|---------|----------|-----------|-----------------|
| Novice 1 | Hal Higdon | Follows the published schedule | 4 + cross | [Free on halhigdon.com](https://www.halhigdon.com/training-programs/marathon-training/novice-1-marathon/) |
| Novice 2 | Hal Higdon | Follows the published schedule | 4 + cross | [Free on halhigdon.com](https://www.halhigdon.com/training-programs/marathon-training/novice-2-marathon/) |
| Intermediate 1 | Hal Higdon | Follows the published schedule | 5 + cross | [Free on halhigdon.com](https://www.halhigdon.com/training-programs/marathon-training/intermediate-1-marathon/) |
| Advanced 1 | Hal Higdon | Follows the published schedule | 6 | [Free on halhigdon.com](https://www.halhigdon.com/training-programs/marathon-training/advanced-1-marathon/) |
| Beginner (Just Finish) | Hansons Marathon Method | Built from the published method | 6 | [Luke Humphrey Running](https://lukehumphreyrunning.com/) |
| 18/55 | Pete Pfitzinger | Simplified version (no LT/VO₂max sessions or tune-up races yet) | 5 | [*Advanced Marathoning* (Human Kinetics)](https://us.humankinetics.com/products/advanced-marathoning-4th-edition) |
| Marathon Plan | Nike Run Club | Simplified version | 5 | [Nike Run Club app (free)](https://www.nike.com/nrc-app) |
| Run Less, Run Faster | FIRST | Built from the published method | 3 + 2 cross | [FIRST at Furman University](https://www.furman.edu/first/) |

> Apollo is independent, free and not affiliated with any coach, author, publisher or brand. Coach and brand names say which published method a plan follows. They don't mean the coach or brand made, licensed or endorses Apollo's version. For the official plan and full coaching, use the coach's own website, book or app.

**Custom Plan Builder** generates progressive plans with cutback weeks every 4th week (86% volume), a two-week taper (72% then 45%), and varied workout types (easy, long, tempo, speed, cross training). Mileage builds from your current weekly volume to your target peak.

---

## Smart Auto-Sync

Connect a data source once — or import your files — and Apollo handles the rest.

**How it works:**
1. **First sync imports your full history** from every connected source (Garmin Connect, intervals.icu and/or Strava), year by year; after that, each sync is incremental (new and recently edited activities only)
2. **Duplicates are merged automatically** — the same run recorded on your watch, synced to Garmin Connect and intervals.icu, and imported from a FIT file is stored once, keeping the richest data from each copy (Garmin Connect's own numbers win when sources disagree)
3. Each run is matched to a plan day by date (if multiple runs on the same day, the longest one is used); **cross-training days** are fulfilled by rides, swims, Zwift, or strength sessions of 10+ minutes
4. Matched workouts are auto-completed
5. For each match, Apollo generates **coaching feedback** — distance analysis against the target, pace commentary tailored to the workout type (easy, tempo, speed, long), and weekly mileage status

**After every sync or import, Apollo also:**
- Captures heart rate data for zone analysis and efficiency tracking
- Processes route effort recognitions (repeated route detection + tier ranking)
- Updates race predictions with the latest data
- Recalculates training adherence and weekly readiness
- Generates daily recap and adaptive recommendations if due

This happens automatically when you open Today or the Plan page, on launch and in the background if you enable auto-sync, and immediately after a file import — no internet needed for imported files.

---

## Route Maps

Every synced or imported activity with GPS is rendered as a pure SVG route visualization. No Leaflet. No Mapbox. No API keys. Works fully offline.

- **Polyline decoding** — GPS tracks from Garmin Connect original files, intervals.icu streams, imported FIT/GPX/TCX files, or Strava are stored as compact encoded polylines and decoded into coordinates
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

Visible throughout the app: Activities, Today, the training calendar, and the expanded detail panels.

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

Apollo predicts race times from Jack Daniels' VDOT, using the best evidence it has, in this order:

1. The **recent race** you enter in Settings › Athlete Profile
2. **Races** found in your synced runs
3. Best 5K+ efforts from recent runs
4. A heart-rate estimate from steady runs (low confidence)

When the VDOT comes from a real race, the marathon time is blended 50/50 with Pete Riegel's formula (exponent 1.06). The slow end of the range uses a steeper Riegel exponent (1.07, or 1.08 below 40 mi/week; Vickers & Vertosick 2016). Easy runs can never lower a race-based VDOT, and your goal time sets paces but is never used as a prediction.

**Predictions for:** Marathon · Half Marathon · 10K · 5K, each with a confidence level.

---

## Coaching Intelligence

### Daily Training Recaps

After each training day, Apollo grades your effort and delivers a focused coach message.

**Grades:** Outstanding · Strong · Solid · Missed · Rest Day

Each recap includes actual distance vs planned (with ± percentage), pace, duration, HR zone, and a workout-specific message. If you ran an easy day at threshold pace, Apollo will flag it. If you crushed a long run, Apollo acknowledges it. Short sleep synced from your watch gets a recovery reminder. Up to 365 days of recap history.

### Daily Recovery Check

With intervals.icu connected and wellness sync turned on (Settings › Sync; off by default for new installs), Apollo syncs the wellness data your watch or ring records — sleep, resting heart rate, HRV (rMSSD), plus any fatigue/soreness/stress you log in intervals.icu — and compares today against **your own** baselines rather than population norms:

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

All plan changes are **reversible** — they're applied as edits on top of your plan, and every applied recommendation can be undone. Safety guardrails cap mileage increases at 10% and never add mileage during the taper.

Configurable in Settings › Coaching: frequency (daily / weekly / before key workouts) and aggressiveness (conservative / balanced / aggressive).

---

## Race Strategy

Apollo's Race Strategy feature lets you build course-specific pacing plans with grade-adjusted splits, elevation visualization, and fuel timing — for six of the seven World Marathon Majors or any custom marathon you import.

### World Marathon Majors Database

Six course profiles. Sydney became the seventh Major in 2025 and isn't in Apollo yet (coming); add it as a custom race meanwhile.

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

### Fuel Timing

Every strategy includes gel and fluid timing coordinated with aid stations. The full plan lives on the Race Day › Fuel tab; see [Race Fueling](#race-fueling).

### Heart Rate Zone Analysis

Standard five-zone model:

| Zone | Name | Effort |
|------|------|--------|
| 1 | Recovery | Very easy conversational pace |
| 2 | Aerobic | Comfortable pace — the engine builder |
| 3 | Tempo | Comfortably hard — lactate threshold development |
| 4 | Threshold | Hard — sustainable for ~30 minutes |
| 5 | VO2 Max | Very hard — peak oxygen uptake training |

**Zone distribution chart** (last 30 days) with 80/20 rule guidance — most training should be in Zones 1–2. Runs without second-by-second heart rate have their zones estimated from average heart rate, and the chart says so (with the estimated share). **HR trend chart** showing daily averages. **Aerobic efficiency tracking** (pace-to-HR ratio over time). Auto-detects and updates max HR when a synced or imported activity reports a higher value. With intervals.icu connected, resting HR follows your watch's recent readings and max HR / LTHR come from your intervals.icu run settings — unless you've entered your own values.

---

## Race Fueling

Race Day › Fuel turns sports-nutrition guidance into a plan for your race. It's guidance, not medical advice: practise it in training first.

### Carb Loading

Following Burke et al. (2011) and the ACSM (2016):

| When | Target |
|------|--------|
| Final 36–48 h | 8–12 g/kg/day (default 10) |
| D-3 (optional lead-in) | Up to 8 g/kg/day |
| Race morning | 1–3 g/kg by breakfast size (default 2 g/kg), ~3 h before the start; never more than ~1 g/kg per hour before the start |

- **Meal-by-meal breakdown** with food suggestions
- **Scales to body weight** (targets use at most 90 kg of body mass)
- **One breakfast rule** shared with the race-morning timeline

### In-Race Fueling

- **Carb rate** within one ceiling of 20–90 g/h (Jeukendrup 2014), based on your pace, experience, and gut training
- **Gel schedule** timed through the race and coordinated with aid stations; the plan delivers the target it states
- **Live on the race card** — the race card reads the current fuel plan, not a copy saved earlier

### Hydration and Sweat Test

- **Sweat test** — weigh yourself before and after a 45–90 minute run at race effort, note what you drank, and Apollo works out your sweat rate
- **Fluid ceiling** — planned fluid stays under your sweat rate × 0.8 and never above 800 mL/h. It's a limit, not a target
- **Sodium** — 300–600 mg/h, or 500–1,000 mg/h if you tick *salty sweater*

### Caffeine (optional)

Off unless you tick *I use caffeine during races* in Settings › Athlete Profile. Then the card offers about 3 mg/kg roughly 60 minutes before the start, or 1–3 mg/kg late in a long race (Goldstein 2010; ISSN 2021), with cautions and a 400 mg daily limit. Only use caffeine you've tried in training.

---

## Race Morning & Course Training

### Race Morning Timeline

Complete race morning schedule, timed backward from the starting gun (Race Day › Race Morning).

- **Events generated:** Alarm, breakfast, leave for venue, arrive, gear check, warmup, corral entry, gun time, projected finish, post-race recovery
- **Breakfast carb target** scaled to body weight, using the same rule as carb loading
- **Configurable:** Travel time, meal preference (light/moderate/full), warmup toggle

### Course-Specific Training

Course-specific preparation for the six Majors in Apollo (Race Day › Course).

| Major | Training Focus |
|-------|---------------|
| **Boston** | Hill repeats, downhill training, Heartbreak Hill simulation, quad-eccentric work |
| **New York** | Bridge climbs, 5-borough terrain variety, Central Park finish hills |
| **Chicago** | Wind resistance training, flat-course pacing discipline |
| **London** | Even pacing on flat terrain, Thames path simulation |
| **Berlin** | PB-focused speed work, pace discipline for the world's fastest course |
| **Tokyo** | Heat/humidity adaptation, early-race conservative pacing |
| **Other races** | Adapts to hilly vs flat based on course profile |

---

## Calendar Export

Export your entire training plan as a standard `.ics` (iCalendar) file. One-click import into Google Calendar, Outlook, Apple Calendar, or any RFC 5545-compliant calendar app.

**What each event includes:**
- **Title** — workout type and distance (e.g., "Long Run — 20 mi")
- **Duration** — estimated from VDOT pace zones: easy runs at easy pace, tempo runs at threshold pace, marathon-pace runs at marathon pace
- **Description** — VDOT pace targets, interval structure, and workout guidance
- **Unique IDs** — RFC 5545-compliant UIDs for clean re-import without duplicates

**Export options** (Plan page › Export):
- Include or exclude rest days
- Export the whole plan or only from today
- Download triggers a browser-native file save

**Duration estimation:**
- Uses your saved VDOT training paces when available
- Falls back to 9:30/mi for new users
- Long runs add 15 sec/mi to easy pace to account for fatigue
- Interval workouts calculate work + rest + warmup + cooldown time

---

## Race Week Checklist

A race-week checklist on Race Day › Race Week, with course-specific items for the six Majors in Apollo.

**Default items across 6 categories:**

| Category | Example Items |
|----------|--------------|
| **Gear** | Race shoes, race outfit, GPS watch, anti-chafe, sunglasses, hat |
| **Nutrition** | Gels, electrolytes, race morning breakfast, water bottle |
| **Logistics** | Bib pickup, travel arrangements, hotel/parking, bag drop plan |
| **Race Morning** | Alarm set, breakfast timed, sunscreen, dynamic warmup |
| **Mental Preparation** | Review race strategy, set mantras, visualize key miles |
| **Post-Race** | Recovery clothes, foam roller, post-race meal planned |

**Course-specific items:**

| Marathon | Added Items |
|----------|------------|
| **Boston** | Warm layers for Hopkinton, bus schedule, discard clothes, Newton Hills strategy |
| **New York** | Fort Wadsworth logistics, 5-bridge strategy, Queensboro mental plan |
| **Chicago** | Lakefront wind layers, wind protection strategy |
| **London** | Rain gear backup, cobblestone section awareness |
| **Berlin** | Flat-course pacing discipline, Brandenburg Gate finish plan |
| **Tokyo** | Humidity gear, food station awareness |

**Managing it:** check items off with progress tracking, add your own items, hide items you don't need, and reset to start fresh. Everything is stored locally.

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
- Emergency contact (name + phone)
- Notes (corral number, wave start time, special instructions)

**Output:**
- Print-optimized HTML with `@media print` CSS
- Apollo gold branding, compact 9pt layout
- Download as an `.html` file or print directly (through a hidden frame, no pop-up window)
- Sandboxed preview, and HTML entity escaping on all user input

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

## Fitness & Form Chart (PMC)

Progress › Fitness & Form: a full CTL/ATL/TSB fitness-fatigue model (Banister) — the same chart used by professional coaches in TrainingPeaks, built from your synced and imported runs (cross-training load can be included).

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
| Very fresh | > 30 | Long break or a very light block |

**Features:**
- Activity-to-TSS conversion using distance, duration, elevation, and heart rate
- Workout type classification (recovery / easy / moderate / hard / race)
- Auto-generated annotations for key events (CTL peak, TSB extremes, taper start/end, race day)
- Projection to race day that follows your planned workouts (or your recent average if there's no plan)
- **Race-morning form** — your projected TSB on race morning, before the race itself, so taper decisions read the right number
- New users see a seeded or hidden form value instead of a misleading "Overreached"
- A form chip on Today shows the current zone

---

## Structured Workouts & VDOT Pacing

Every workout in your plan includes VDOT-calculated pace targets based on Jack Daniels' methodology.

- **Pace zones:** Easy, Marathon, Tempo, Interval, Repetition — each with per-mile and per-km targets
- **Dynamic recalculation:** Paces update as your VDOT improves through training
- **Workout compliance analysis:** Tracks whether you're hitting prescribed paces with grade-based feedback
- **Structured workout types:** Easy runs, long runs, tempo runs, interval sessions, and repetition work — each with specific warm-up and cool-down guidance

---

## Data Safety & Backups

Your training data is important. Apollo protects it at multiple levels.

- **Dual persistence:** every write goes to both localStorage (instant, synchronous) and IndexedDB (durable, async). If either is cleared, the other restores it automatically on next launch.
- **"Not saved" banner** — if a save ever fails (disk full, another window holding a lock), Apollo says so, keeps retrying quietly, and offers a *Retry* button. Apollo also saves when you close or quit
- **Automatic backups** — configurable interval (12 hours to 1 week), retention count (how many backups to keep), runs silently on app startup, kept in their own storage table
- **SHA-256 integrity checksums** — every backup is read back and verified after it's written, and again on restore. Tampered backups are flagged immediately
- **Damaged data set aside** — a corrupt activity store is quarantined instead of wiping your history; Settings › Data & Privacy shows what was set aside
- **One-click export** — download everything as a single JSON file
- **Safe import** — file size limits (10 MB), per-key size limits (1 MB), key allowlist validation, checksum verification, and a safety backup created before any restore
- **Backup health monitoring** — Settings › Data & Privacy shows a status badge (Protected / Needs attention / At risk, or No backup yet) based on backup age and integrity
- **Backup history** — every backup listed with date, size, key count, trigger type (auto/manual), and integrity status

---

## Integrations

Use any combination of these — or none at all. Everything except Strava is free.

| Source | Cost | What you get |
|--------|------|--------------|
| **Garmin Connect** *(direct, desktop app)* | Free (your own personal API key) | Read-only sync of every activity, with routes, splits, and laps from your watch's original files |
| **[intervals.icu](https://intervals.icu)** *(recommended)* | Free | Automatic sync of runs, rides, swims, and strength from COROS, Suunto, Polar, Wahoo, Zwift, and more — plus sleep, HRV, and resting HR for the recovery check, and plan delivery to your watch (Garmin included) |
| **File & archive import** | Free, no account | FIT, GPX, TCX (and `.gz`), Garmin Connect data export, Strava bulk export |
| **Strava** | Requires Strava API access (desktop app) | Read-only OAuth sync of activities, splits, and laps |

### Garmin Connect (direct — desktop app)

Garmin now lets every Garmin Connect user create a **personal API key** for their own data. Apollo uses it to sync straight from Garmin Connect: no intervals.icu or Strava account in between, no developer approval, no server.

**Setup (about two minutes):**
1. Sign in to Garmin Connect on the web and open [Settings › Personal API Key](https://connect.garmin.com/app/settings/personalApiToken).
2. Select **Create Key**, accept Garmin's terms, and choose how long the key lasts (30, 90 or 180 days, or one year).
3. Copy the key (Garmin shows it only once). In Apollo, open **Settings › Connections › Garmin Connect**, paste it, optionally pick the expiry you chose, and click **Connect Garmin & import history**.

Apollo checks the key, stores it encrypted (OS keychain), and imports your full history year by year. After that, each sync fetches only new and recently edited activities.

**What Apollo fetches:** every activity type with distance, moving and elapsed time, pace/speed, elevation, heart rate (average + max), cadence, power (average + normalized), calories, and TSS for power-based activities. Garmin's activity lists carry no GPS, so Apollo downloads the **original file** from your watch for recent outdoor runs (the last 120 days, up to 12 per sync) and for any activity whose details you open. That's where the route map, per-mile/km splits, device laps, and best efforts come from. Multisport sessions are stored as their legs (run, ride, swim).

**Good to know:**
- **Keys expire.** Apollo reminds you a week before the expiry you chose. If Garmin rejects the key (expired, deleted, or mistyped), Garmin sync pauses with a *Reconnect needed* banner. Create a new key in Garmin Connect and choose **Replace key**: your history and sync progress are kept.
- **Desktop only.** Garmin's API rejects requests from web browsers, so the browser version can't connect. Import FIT files or a Garmin export there instead.
- **Read-only, for your own data.** Garmin's Personal API is meant for personal use and can't write to your account, so sending your plan to the watch still goes through intervals.icu ([Workouts to Your Watch](#workouts-to-your-watch)).
- **Private by design.** The key is sent only to Garmin. Apollo's main process makes the calls, to one fixed Garmin address and only the read endpoints Apollo needs. Disconnecting removes the key from your computer; to revoke the key itself, delete it in Garmin Connect.

### intervals.icu (free — recommended)

intervals.icu is a free training platform that connects directly to Garmin Connect, COROS, Suunto, Polar, Wahoo, Zwift, and others. Apollo uses it as a free hub: your watch syncs to intervals.icu, and Apollo syncs from intervals.icu — no Strava subscription, no developer approval, no server.

**Setup (about two minutes):**
1. Create a free account at [intervals.icu](https://intervals.icu) and connect your watch or platform under **Settings → Connections**. To receive Apollo's plan on your watch, tick **Upload planned workouts** on that device's box.
2. In intervals.icu, open **Settings → Developer Settings** and copy your **API key** (your athlete ID, e.g. `i12345`, is optional).
3. In Apollo, open **Settings › Connections › intervals.icu**, paste the key, and click **Connect**.

Apollo verifies the key, stores it encrypted (OS keychain on desktop), turns on auto-sync, and imports your full history. Wellness sync is a separate checkbox (off by default for new installs). After that, every sync fetches only new and recently edited activities.

**What Apollo fetches:** every activity type with distance, moving time, pace/speed, elevation, heart rate (average + max), cadence, power (average + normalized), training load, and indoor/trainer flags — plus GPS routes and per-mile/km splits from the activity streams. It also reads your **wellness** data (sleep, resting HR, HRV, and anything you log such as fatigue or soreness — up to a year back, then the last week on every sync) for the [Daily Recovery Check](#daily-recovery-check), and your **run settings** (max HR, LTHR, threshold pace). To get wellness data, let your watch or ring send it to intervals.icu (for Garmin, enable wellness data on the Garmin connection in intervals.icu → Settings → Connections).

> [!NOTE]
> Activities that reached intervals.icu *from Strava* aren't exposed through intervals.icu's API (a Strava licensing restriction). Connect your watch to intervals.icu directly, or import your Strava export ZIP once to bring in that history.

### Workouts to Your Watch

Apollo writes your training plan into your intervals.icu calendar as structured workouts, and intervals.icu delivers them to your watch. Use the **Send your plan to your watch** card on the Plan page (under Export):

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

**Where:** the **Import files** button on the Activities page, or the *Import activity files* card in Settings › Connections. Drop files, whole folders, or the export ZIP exactly as you downloaded it — or click *Choose files*.

Files are parsed entirely on your device — nothing is uploaded anywhere. The import keeps running if you switch pages, and you can cancel at any time without losing what was already read. Re-importing is safe: duplicates are detected by start time and distance and merged with any copy already synced from intervals.icu or Strava. Imported runs are matched to your plan immediately, even offline. Apollo keeps your 5,000 most recent activities on the device (more than 13 years of daily runs) and tells you if an import goes past that.

### Strava (optional)

Strava API access is no longer freely available to every athlete. If your account has it, Apollo syncs with read-only access (`read,activity:read_all`):

| Platform | Method |
|----------|--------|
| **Desktop (Electron)** | Enter Client ID + Client Secret in Settings › Connections → OAuth redirect to `127.0.0.1` |
| **Web (self-hosted on Azure)** | One-click OAuth via Azure Functions token exchange |
| **Web (GitHub Pages)** | Not available — use intervals.icu or file import, or the desktop app. Old Strava tokens can still be disconnected |

Apollo fetches: activities, heart rate (average + max), cadence, elevation, suffer score, GPS polylines, split data (metric + standard), and lap data.

**Setup (desktop):**
1. Create an app at [Strava API Settings](https://www.strava.com/settings/api)
2. Set Authorization Callback Domain to `127.0.0.1`
3. In Apollo Settings, enter your Client ID and Client Secret
4. Click **Connect Strava**

**Setup (web):** see [Deploy to Azure Static Web Apps](#deploy-to-azure-static-web-apps).

**Rate limiting:** Apollo tracks Strava's rate limits via response headers and maintains a buffer below the 15-minute and daily caps. Token refresh is mutex-protected to prevent concurrent refresh races.

If you connect more than one source, activities are de-duplicated automatically.

### Garmin Devices

Three free ways in: **directly** with your Garmin Connect personal API key ([desktop app](#garmin-connect-direct--desktop-app)), **through intervals.icu** (which also delivers Apollo's planned workouts to your watch), or **by importing** FIT files or your Garmin data export.

> [!NOTE]
> Garmin's relaunched developer program (October 2026) may stop intervals.icu from passing Garmin activities to apps like Apollo. If that happens, Apollo keeps the Garmin activities it already has (they aren't treated as deleted) and skips empty placeholder rows. Connect Garmin Connect directly to keep new ones coming.

---

## Security & Privacy

Apollo is built with a security-first mindset. Every layer of the stack — from Electron's main process to the persistence layer — is hardened against common attack vectors.

### Data Privacy

- **100% offline-capable** — all data lives in localStorage + IndexedDB on your machine
- **No telemetry** — Apollo collects zero analytics, usage data, or crash reports
- **No cloud accounts** — no login, no email, no phone number
- **Every data connection is opt-in** — Garmin Connect, intervals.icu and Strava are optional; file import is parsed entirely on your device and works offline
- **Health data stays local** — sleep, HRV, and resting-HR records synced from intervals.icu are stored only on your device (about the last 400 days) and are never sent anywhere else; switch the sync off any time in Settings
- **Writes only what it owns** — sending your plan to the intervals.icu calendar creates, updates, and removes only events tagged with Apollo's own ID; your other workouts, notes, and past days are never modified

### Credential Security (Desktop)

- **OS-level encryption** — your Garmin Connect personal API key, intervals.icu API key and Strava credentials/tokens are encrypted via Electron's `safeStorage` API (DPAPI on Windows, Keychain on macOS, libsecret on Linux)
- **Encrypted-at-rest** — credentials stored as Base64 AES blobs in a JSON file in the app's userData directory, never in localStorage or IndexedDB
- **Key allowlisting** — IPC handlers only accept a fixed set of credential keys (`garmin_personal_api`, `intervals_credentials`, `strava_tokens`, `strava_credentials`, and the legacy `garmin_tokens` / `garmin_credentials` keys). Arbitrary key names are rejected.
- **Web fallback** — in the browser (no OS keychain), the intervals.icu key is stored in browser storage with a warning; on a self-hosted Azure deployment, the Strava client secret stays in the Azure Functions backend

### Electron Hardening

| Protection | Status |
|-----------|--------|
| `contextIsolation` | ✅ Enabled — renderer cannot access Node.js |
| `sandbox` | ✅ Enabled for the renderer |
| `nodeIntegration` | ✅ Disabled |
| `webSecurity` | ✅ Always enabled (production and development) |
| `webviewTag` | ✅ Disabled |
| `nodeIntegrationInWorker` | ✅ Disabled |
| `will-navigate` guard | ✅ Only allows `localhost:5173` and `file:` origins |
| `setWindowOpenHandler` | ✅ All new windows denied; allow-listed HTTPS URLs opened in OS browser |
| `open-external` allowlist | ✅ HTTPS only, no credentials or custom ports; only activity platforms (`intervals.icu`, `strava.com`, `connect.garmin.com`), the official race and coach sites Apollo links to, and this project's GitHub releases page |
| Garmin Connect proxy | ✅ The main process calls one fixed `https://` Garmin origin: the key-for-token exchange, then GET-only calls to an allow-list of read endpoints with numeric IDs, checked and encoded query values, JWT-shaped tokens, size caps and timeouts. Nothing is stored or logged there |
| DevTools | ✅ Only in development builds |

### Web Security

- **Content Security Policy** — strict CSP in `staticwebapp.config.json`: `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `connect-src` limited to intervals.icu and Strava
- **X-Frame-Options** — `DENY`
- **X-Content-Type-Options** — `nosniff`
- **Referrer-Policy** — `strict-origin-when-cross-origin`
- **Permissions-Policy** — camera, microphone, and geolocation all disabled

### Application Security

| Vector | Protection |
|--------|-----------|
| XSS | React JSX auto-escaping; zero `dangerouslySetInnerHTML`; dedicated `esc()` HTML encoder for race card; Blob URL pattern for print windows |
| Code injection | Zero `eval()`, `new Function()`, `setTimeout(string)`, or `child_process` usage |
| SSRF | All external hosts hardcoded (`intervals.icu`, `strava.com`, `personal.connectapi.garmin.com`); Garmin request URLs are built in the main process from an allow-list of paths with numeric IDs and validated query values; no user-controlled hosts |
| Prototype pollution | No `Object.assign` with unvalidated external data; no `__proto__` access |
| OAuth CSRF | Cryptographic state parameter (32 random bytes) validated on callback; single-use |
| Token refresh | Mutex-protected to prevent concurrent refresh races |
| API rate limiting | Strava rate limits tracked via response headers with configurable buffer; intervals.icu requests time out after 30 s and back off on 429/5xx; Garmin requests are spaced at least 0.5 s apart, time out (30 s, 90 s for files) and honour `Retry-After` on 429 |
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
2. **Connect Garmin Connect** directly in Settings (desktop app, with your free personal API key) or **intervals.icu** (free — link your COROS, Suunto, Polar, Wahoo, or Zwift account to intervals.icu first), or **import your files/export** if you'd rather not use any account. Strava works too if you have API access
3. **Send your plan to your watch** (optional) — push it to your intervals.icu calendar and today's workout appears on your device
4. **Run your first planned workout** and record it on your watch as usual
5. **Open Apollo** — your run syncs automatically, your day is marked complete, and you receive your first coaching feedback

### Every Run Day

1. Check the **Training Calendar** for today's workout (or just start it from your watch)
2. Run and record as usual (GPS + heart rate for the richest insights)
3. Open Apollo — auto-sync fires on Today. You'll see your route map, coaching feedback, and (once you have repeat routes) effort recognition

### Every Week

- Review **Weekly Readiness** on the Progress page — identify strengths and areas to improve
- Check your **race prediction** trend — is your projected time getting faster?
- Look at **HR zone distribution** — are you following the 80/20 rule?
- If Apollo surfaces an **adaptive recommendation**, review the reasoning and accept or dismiss

### Building Toward Race Day

- **Run your regular routes often** — effort history builds with every repeat, and you'll start earning Gold/Silver/Bronze tiers
- **Monitor adherence** — above 85% correlates with stronger race outcomes
- **Watch your readiness grade climb** week by week as consistency compounds
- **Trust the taper** — Apollo adjusts recommendations in race week and will tell you when to ease off
- **In race week**, open **Race Day** — your strategy, fuel plan, checklist, race card, and race-morning timeline are all there

---

## Experimental (not in the app yet)

These modules exist in [`src/labs/`](src/labs/README.md) but **no screen uses them**, and several have known errors that must be fixed first. They aren't features yet, and their tests don't count toward the app total.

Ghost runner · bonk risk · glycogen model · hydration calculator · what-if simulator · aerobic decoupling · running economy · fatigue resistance · pacing decay · race equivalence · post-race analysis · weather (Open-Meteo) · shoe tracking · an old Garmin partner-API stub (superseded: direct Garmin sync now ships through the [Personal API](#garmin-connect-direct--desktop-app)).

See [src/labs/README.md](src/labs/README.md) for what each was meant to do and what must be fixed before it gets a screen.

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
npm run build:pages   # the GitHub Pages build (base /Apollo-Running/)
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

**About 2,000 app tests** across 102 test files, all passing (`npx vitest run --exclude 'src/labs/**'`). `npm test` also runs the tests for the experimental modules in `src/labs/`; those are reported separately and don't count toward the app total (see [src/labs/README.md](src/labs/README.md#tests)).

The suites cover plans and the custom builder, VDOT paces and predictions, plan fidelity, sync (Garmin Connect, intervals.icu, Strava), the desktop security policies (external links, navigation, the Garmin request allow-list), file import (FIT/GPX/TCX/ZIP), de-duplication, backups and storage health, fitness & form, fueling, race strategy, race card, checklists, and the main screens.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18, TypeScript 5 (strict), Vite 7, React Router 6 |
| **Desktop** | Electron 44 with fuses, secure preload IPC, safeStorage credential encryption |
| **Charts** | Recharts 3 (analytics) + custom pure SVG (routes, splits, gauges) |
| **Persistence** | localStorage + IndexedDB via Dexie 4 — dual-write, auto-hydration |
| **Web** | GitHub Pages (free web version); optional Azure Static Web Apps + Functions for Strava OAuth |
| **Integrations** | Garmin Connect Personal API (desktop — read-only, through an allow-listed main-process proxy; original FIT files for routes and splits), intervals.icu REST API (free — activities, streams, wellness, sport settings, calendar events), Strava API v3 (optional — OAuth2, rate-limited, mutex-protected refresh), dependency-free FIT/GPX/TCX/ZIP parsing |
| **Testing** | Vitest 4 with jsdom (about 2,000 app tests), Playwright Electron smoke test in CI, v8 coverage |
| **Security** | CSP headers, navigation guards, IPC key allowlisting, allow-listed Garmin request proxy, SHA-256 backup verification |
| **Design** | Art Deco system — navy `#0D1B2A` + gold `#D4A537`, Montserrat / Inter / JetBrains Mono |

---

## Project Structure

```
src/
├── pages/                  Six sections + onboarding + auth callback + 404
│   ├── Dashboard.tsx         Today — workout, form, recovery, this week, prediction, recommendations
│   ├── Training.tsx          Plan — chooser, phase ribbon, calendar + checklist, day actions, export, auto-sync
│   ├── Activities.tsx        Activity history — runs + cross-training, sport filters, file import, splits
│   ├── Progress.tsx          Progress tabs — Overview · Fitness & Form · Trends · Heart Rate · Recaps
│   ├── Analytics.tsx         Trends tab — distance, pace, HR efficiency, consistency, PRs
│   ├── Insights.tsx          Overview, Heart Rate and Recaps panels
│   ├── RaceDay.tsx           Race Day tabs — Strategy · Fuel · Race Week · Race Morning · Course
│   ├── Settings.tsx          Settings tabs (settings/) — Connections, Sync, Athlete Profile, Coaching, Data & Privacy, About
│   └── WelcomeFlow.tsx       Guided onboarding (units, plan, recent race, connect)
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
│   ├── SaveStatusBanner.tsx  "Not saved" banner with retry
│   ├── MultiTabNotice.tsx    Web: "Apollo is open in another tab"
│   ├── PlanCalendarExport.tsx  .ics export card
│   ├── today/ plan/ race/ fitness/ activities/ ui/   Section components
│   ├── ErrorBoundary.tsx     React error boundary
│   └── LoadingScreen.tsx     Boot loading state
│
├── data/
│   ├── plans.ts              8 built-in plans + custom builder + recommendation engine
│   └── worldMajors.ts        6 of the 7 World Marathon Majors (Sydney not yet) with course profiles
│
├── services/
│   ├── activitySource.ts     Sync engine — every connected source, full/incremental sync, events
│   ├── intervals.ts          intervals.icu API client (activities, streams, wellness, calendar events)
│   ├── garmin.ts             Garmin Connect Personal API client (tokens, activity lists, original files)
│   ├── garminFit.ts          Garmin original file (ZIP → FIT/GPX/TCX) → route, splits, laps, best efforts
│   ├── planCalendarSync.ts   Plan → intervals.icu structured workouts (push, auto-update, remove)
│   ├── wellness.ts           Sleep/HRV/resting-HR sync, recovery snapshot, threshold-pace check
│   ├── crossTraining.ts      Cross-training load estimates and summaries
│   ├── activity/
│   │   ├── types.ts            Source-neutral Activity model
│   │   ├── sports.ts           Sport categories + sport-name normalization shared by imports and live sources
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
│   ├── carbLoading.ts         3-day carb loading protocol generator
│   ├── fuelingCalculator.ts   In-race fueling, sweat test, fluid ceiling, caffeine card
│   ├── raceDayTimeline.ts     Race morning schedule generator
│   ├── courseTraining.ts      World Major-specific training plans
│   ├── taperOptimizer.ts      Banister CTL/ATL/TSB maths used by the fitness & form chart
│   ├── paceCalculator.ts      VDOT pace zone calculator
│   ├── workoutTargets.ts      Structured workout generation
│   ├── complianceAnalysis.ts  Workout compliance tracking
│   ├── trainingJournal.ts     Journal store (read by daily recaps; no journal screen yet)
│   ├── calendarExport.ts      .ics calendar export with VDOT paces
│   ├── raceChecklist.ts       Race week checklist with course items
│   ├── raceCard.ts            Printable one-page race day companion
│   ├── periodization.ts       Training phase detection + coaching tips
│   ├── pmcChart.ts            CTL/ATL/TSB, race-morning form
│   ├── appPreferences.ts     Auto-sync and auto-update preferences
│   ├── coachingPreferences.ts  Scheduling and notification settings
│   ├── unitPreferences.ts    Miles/km toggle + all conversion helpers
│   ├── strava.ts             Strava API client (optional; rate-limited, mutex refresh)
│   ├── stravaWeb.ts          Web-mode Strava OAuth helpers
│   ├── storage.ts            Cross-platform token/credential management (OS keychain on desktop)
│   ├── dataManager.ts        Export/import with validation
│   ├── planProgress.ts       Plan state, completion tracking, sync metadata
│   └── db/
│       ├── apolloDB.ts         Dexie IndexedDB schema
│       └── persistence.ts      Unified persistence layer (cache + IDB + localStorage)
│
├── labs/                   Experimental modules with no screen (see labs/README.md)
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
└── __tests__/                App tests (about 2,000 across 102 files)
    └── setup.ts              Test harness with in-memory persistence mock

electron/                     Electron main process, secure preload, and the pure security + Garmin request policies (security.ts, garminProxy.ts)
api/                          Azure Functions (Strava token exchange)
public/                       Static assets, PWA manifest, SWA config
```

---

## License

MIT © Marc Copeland
