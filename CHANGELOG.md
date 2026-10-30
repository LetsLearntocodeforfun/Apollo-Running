# Changelog

## 1.0.8

**Theme:** your Garmin data, straight from Garmin. v1.0.7 was not published on its own, so everything under 1.0.7 below also ships in 1.0.8.

### Direct Garmin Connect sync (desktop app)
- **Connect with your own Garmin personal API key** (Garmin Connect › Settings › Personal API Key) in **Settings › Connections › Garmin Connect**. Apollo checks the key, stores it encrypted (OS keychain) and imports your full history year by year, then syncs incrementally. No intervals.icu or Strava account needed.
- **Every sport** is imported. Multisport sessions are stored as their legs.
- **Routes, splits, laps and best efforts** come from your watch's original file: outdoor runs from the last 120 days (up to 12 per sync), and any activity whose details you open. Files without a usable workout are marked so they aren't downloaded again.
- **Key expiry:** tell Apollo the expiry you chose (30, 90 or 180 days, or a year) and it warns you a week before. A rejected key pauses Garmin sync with a *Reconnect needed* banner (no silent retries). **Replace key** keeps your history and sync progress.
- **Garmin's numbers win** when the same activity also arrives through intervals.icu, Strava or a file import; Garmin Connect is listed first among sources.
- Garmin activities get their own badge colour and a *View on Garmin Connect* link.
- **Desktop only:** Garmin's API rejects browser requests, so the web version explains how to import FIT files or a Garmin export instead.

### Locked down by design
- Every Garmin call goes through the desktop main process, which only talks to one fixed `https://` Garmin origin: the key-for-token exchange, then GET requests to an allow-list of read endpoints (numeric IDs, checked and encoded query values). Replies are size-capped (16 MB JSON, 64 MB files) and time out (30 s, 90 s for files); file downloads only follow `https://` redirects.
- Bearer tokens (valid up to 24 h; Garmin has no refresh tokens) are minted from the key, cached encrypted and renewed an hour before they expire. After a 401 Apollo renews the token once, then asks you to reconnect.
- Requests are spaced at least 0.5 s apart; network errors, 429 (honouring `Retry-After`) and 5xx are retried.
- The key is never logged, never included in backups or exports, and is removed by *Disconnect* and *Delete all data*.

### intervals.icu and Garmin's new developer terms
- Garmin's relaunched developer program (October 2026) may stop intervals.icu from passing Garmin activities to apps. Apollo no longer treats Garmin activities that disappear from intervals.icu as deleted, and skips the empty placeholder rows intervals.icu may return instead.

### Security and maintenance
- **Electron 44.9.1** (was 44.4.3) with the latest Chromium security fixes; React Router 6.30.6, Vite 7.3.7 and Vitest 4.1.11.
- 38 new tests for the Garmin request policy and client; about 2,000 app tests in total.
- Sport-name normalization is shared by file imports and Garmin Connect (`activity/sports.ts`).
- The *Reconnect needed* banner is shared by the Garmin Connect, intervals.icu and Strava cards.

## 1.0.7

**Theme:** works cleanly, easy to install, nothing removed. Every plan is kept.

### Training advice you can trust
- **Marathon-pace days show and score marathon pace**, not threshold. Today, the plan preview, compliance and the watch now use one classifier, checked for every day of every plan.
- **Plans follow their coach more closely:**
  - FIRST tempos at FIRST's intensities (short and mid tempo from 5K pace; long tempo at marathon pace).
  - Higdon tempos build, hold near 10K pace and ease back. Nike tempos stay continuous, with threshold capped at about 25 min.
  - Each plan's own interval reps (e.g. 8 × 400 m, 3 × 1600 m) on Today and the watch.
  - Hansons marathon pace kept on the watch.
  - No "optional MP finish" on novice long runs.
- **Late-join check:** joining a plan part-way compares the plan week with your recent mileage and longest run. If the jump is unsafe, Apollo offers a later race, a ramp-in or a gentler plan.
- **Custom plans:** long runs stay within a safe share of the week (and about 3.5 h). Easy days stay shorter than the long run. An honest note appears if the timeline is too short.
- **Coaching safety:** no mileage increases during the taper. A max HR you entered is never overwritten. The weekly-jump warning only fires when you run more than the plan prescribes, plus a single-run spike rule.
- **Pace feedback uses your own VDOT bands**, not fixed 8:30 / 9:30 thresholds. Race-week pace comes from your predicted marathon time.
- **Adaptive apply/undo** now goes through the plan overlay: it survives reloads, works on custom plans and never changes the built-in plan.

### Charts that don't mislead
- **Race-morning form:** race-day form is measured before that day's load.
- **New users** see "Building baseline" for the first 28 days instead of "Overreached".
- Form above +30 is "Very fresh", not "detrained".
- **Time in zone** is labelled "estimated" unless it was measured from a heart-rate stream (opened activity details and imported files).

### Race day
- **Caffeine card** (optional): about 3 mg/kg roughly 60 min before, with sleep and tolerance cautions. The Settings caffeine option now does something.
- **Sweat-rate test** and a "salty sweater" option on the Fuel tab.
- The **race card's fuel plan** is computed live, so it always matches the Fuel tab.
- **The fuel plan delivers its target** carbs per hour (e.g. a 1:45 half at 60 g/h: 57 g/h, was 43).
- **One race-breakfast rule** everywhere (the default is now 2 g/kg, was 2.5 g/kg on the Fuel tab). Oatmeal is no longer called low-fibre.
- **One carb range, 20–90 g/h**, across Settings, the Fuel tab and the engine. Stored values outside it are clamped.

### Your data is safe
- A **"Not saved" banner** with Retry appears if a save fails; Apollo keeps retrying.
- **Backups are marked verified only after they are written and read back.** They live in their own table and load only when needed. Backups missing from the list are re-listed on launch.
- A **damaged activity store is set aside**, not overwritten. You can download or discard it in Settings → Data.
- Closing, quitting or updating waits for pending saves.

### Privacy
- Strava asks for **read-only access**.
- Wellness sync is **off for new installs** (existing installs keep their setting).

### Install and platforms
- **Use Apollo in your browser:** a free web version on GitHub Pages. Your data stays in your browser. Strava sync is desktop-only. A notice appears if Apollo is open in two tabs.
- **Install guide for non-coders** ([docs/INSTALL.md](docs/INSTALL.md)), including the one-time prompt on each OS.
- **Verified downloads:** `SHA256SUMS.txt` and build-provenance attestations on every release.
- **Electron 44** with hardened Electron fuses.
- Official race and coach links open on desktop again.
- Groundwork for free Windows signing (SignPath Foundation) and a Microsoft Store package; see [docs/SIGNING.md](docs/SIGNING.md).

### Honesty and cleanup
- Every plan shows how closely it follows its coach, with links to the official source and an independence notice.
- 14 unused science modules moved to `src/labs/`, with their known issues listed. A test stops screens importing them.
- README truth pass: honest test count, feature list and World Majors wording.

### Engineering
- The chart library is no longer preloaded on Today; a CI check guards the bundle size.
- Playwright Electron smoke test in CI on Windows, macOS and Linux.
- ESLint and prettier.
- CI on Node 22, least-privilege, SHA-pinned workflows; the Azure web deploy is manual-only.
