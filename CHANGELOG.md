# Changelog

## 1.0.9

**Theme:** more plans, each honest about where it comes from; data you can take anywhere; illustrated guides; and a tighter local-first security model. Your data still stays on your device.

### 33 plans, each labeled honestly
- **33 built-in schedules:** 29 marathon plans across Hal Higdon (8), Pete Pfitzinger (7), Jack Daniels `2Q` (4), Hansons (3), FIRST, Jeff Galloway, Nike Run Club and four plans designed by Apollo, plus **4 base-building and post-marathon blocks** (`8-Week Aerobic Base Builder`, `12-Week Performance Base`, `4-Week Post-Marathon Reverse Taper`, `6-Week Off-Season Maintenance`).
  - **25 are new in v1.0.9:**
    - Hal Higdon `Novice Supreme`, `Personal Best`, `Intermediate 2` and `Advanced 2`;
    - Pete Pfitzinger `12/55 Method`, `12/70 Method`, `18/70 Method (Doubles)`, `18/85 Elite Method (Doubles)`, and `Multiple Marathoning` (12- and 8-week);
    - Jack Daniels `2Q Marathon` for up to 40, 41–55, 56–70 and 71–85 mpw;
    - Hansons `Just Finish` and `Advanced`;
    - Jeff Galloway `Run-Walk-Run (20-Week)`;
    - the four plans designed by Apollo and the four blocks.
  - The 8 plans from v1.0.8 keep their IDs and schedules, so progress on them carries over.
- **Four new Hal Higdon plans follow his published schedules day for day**, transcribed from the tables on halhigdon.com: `Novice Supreme` (30 weeks), `Personal Best` (30 weeks), `Intermediate 2` and `Advanced 2`.
- **"Designed by Apollo":** Apollo's own plans (`Boston Qualifier (BQ) 18/60`, `Time-on-Feet Endurance (3h Cap)`, `Norwegian-Style Sub-Threshold`, `Canova-Style Specific Block 16/75` and the four blocks) carry this label and cite no coach or book. Coach-based plans keep their fidelity label (*Follows the published schedule*, *Built from the published method* or *Simplified version*) and official links.
- **Names match the schedules:** for example `12/70 Method` and `18/85 Elite Method (Doubles)`. The v1.0.8 Hansons plan is now called `Beginner` (was *Beginner (Just Finish)*), because v1.0.9 adds a separate Hansons `Just Finish` plan; its schedule and ID are unchanged.
- **Daniels `2Q`:** the midweek threshold session is cruise intervals at T pace (1-mile reps with 1-minute jogs), kept to about 10% of the week's mileage. The up-to-40-mpw plan keeps long runs to about 2½ hours (15 mi).
- **Long runs and tapers:** no plan has an 18+ mile run in the two weeks before race week. The Time-on-Feet plan's long runs stop at 3 hours, whatever distance you have covered.
- **Plan Chooser:** category filters, and search that matches every word in any order and case (*Daniels 2Q*, *pfitzinger 18*). Onboarding shows the same peak mileage as the chooser.
- **Base and recovery blocks have no race day:** they start on the date you pick and simply end. The Plan page shows when the block ends, the phase ribbon and Today show a single Base phase, no race countdown or taper comes from them, and your **My Race** date stays in charge.
- **Late-join suggestions** offer only plans that build to a marathon (never a post-marathon bridge or a base block).
- **Portable plans:** export any plan as `.apollo-plan.json` (`apollo.training-plan.v1`) and import it on another device. Imports are checked first (schema version, at most one marathon day and only at the very end, sensible distance limits, hidden characters removed), are always saved as a new plan (a second *My Plan* becomes *My Plan (2)*), and are labeled *Imported plan* ("Imported, not verified by Apollo", with the author shown only as the file lists it). A file that declares any other format is refused. The plan you are following can't be removed; removing another one asks first and also removes that plan's completed days, activity matches, moves and skips (your activities stay). **Export plan** saves the plan itself, without your moves, skips or race-date placement.
- Today and the watch keep a plan's own cruise-interval reps for every runner, as they already did for interval reps.

### Coaching, gear and race preparation
- **Aerobic durability (`Pa:HR` and Efficiency Factor)** on **Progress › Heart Rate:** compares heart-rate drift between the first and second half of steady runs, split by moving time as Friel and TrainingPeaks do (`≤ 5%` counts as coupled), with a grade-adjusted Efficiency Factor (`m/min/bpm`, Minetti) and multi-week trends. Runs need heart rate, at least 4 splits and 30 minutes of steady running; the history uses runs of 40 minutes or more, and long-run readiness uses runs of 60 minutes or more.
- **Shoe garage** on **Activities:** track mileage across trainers and race shoes, set roles and a default shoe, log the shoe for each run, and get a warning if a pair will pass its retirement mileage before race day. Two copies of the same run from different sources (same day, starts within 5 minutes, distances within 3%) count once.
- **Training journal:** effort (`RPE 1–10`), feel tags, and workout and fueling notes for any activity.
- **Course `.gpx` upload** on **Race Day › Strategy:** elevation is smoothed over about 150 m with a 2 m threshold, so GPS noise doesn't read as hills, and the mile splits add up to the course totals. Track pieces more than 200 m apart aren't joined (Apollo keeps the longest piece and says so). A course within 3% of the race distance is fitted to finish exactly at it (the official 42.195 km for a marathon), so mile markers and aid stations never run past the finish.

### Your data
- **Storage is unchanged from v1.0.8.** A new activity storage engine was held back after pre-release testing showed it could lose history in rare failures. v1.0.9 keeps v1.0.8's layout, so v1.0.8 can still read your data if you ever go back.
- **Desktop backup folder:** mirror each verified backup as a compressed `.json.gz` snapshot to a folder you choose (for example iCloud Drive, OneDrive or a NAS). The desktop app checks every snapshot before writing it (Apollo data only, never keys or tokens), writes it to a private temporary file and then renames it, never deletes the snapshot it just wrote, and ignores future-dated files when it tidies up old ones. If a copy fails, **Settings › Data & Privacy** says so. Disk roots and network-share roots (including a link that points to one) aren't accepted.
- **CSV export:** activities, splits, wellness and journal entries. Every text cell is quoted, and anything that could start a spreadsheet formula is neutralized with a leading `'`: at the start of a cell, and after a `;` or line break inside one (spreadsheet apps that split on semicolons would otherwise treat that text as a new cell). Full-width and hidden characters can't sneak a formula past it. So a journal line starting with `- ` exports as `'- `.
- **No incomplete files:** while storage is unavailable, downloads and CSV exports wait (as backups and restores already did) instead of producing a file that could be missing data.
- **Delete all data** now also disconnects the desktop backup folder. Snapshots already in that folder stay there until you delete them.

### Security and privacy
- **Network allow-list (desktop):** the app window can only reach `intervals.icu` and `www.strava.com`, matching the Content Security Policy; everything else is blocked and noted in the log. Garmin Connect goes only through the main process.
- **Local files:** the window can load only Apollo's own files (encoded separators and `..` paths are refused), and every message from the window to the main process is checked to come from Apollo's own page.
- **Update checks no longer carry a device ID.** The update library adds a random ID it keeps on your computer to every update check; Apollo removes it before the request leaves your computer. Which update you get doesn't change, and update checks stay opt-in.
- **Spellcheck runs only on macOS**, which uses the system dictionary. On Windows and Linux it is off, because Chromium would download dictionaries from Google.
- **Settings › Data & Privacy** now lists Garmin Connect (and says original files may come from Garmin's file-storage host) and GitHub's release-download host.
- The optional self-hosted Strava sign-in function sends `Cache-Control: no-store`, validates tokens, times out after 15 s and answers timeouts with a clear `504`.
- Course `.gpx` uploads are capped (15 MB, 250,000 points, 1,000 waypoints), and backup imports accept only Apollo's own data keys.

### End-user documentation
- **[Illustrated Quick-Start Guide](docs/QUICK_START_GUIDE.md)**, with annotated screenshots and diagrams.
- **[Training Program Guide](docs/TRAINING_PROGRAM_GUIDE.md):** choosing a plan, VDOT and heart-rate zones, fitness and form (`CTL`/`ATL`/`TSB`), aerobic durability, tapering and race-day execution.

### Under the hood
- **Large histories stay quick:** shoe mileage and the shoe column on Activities are worked out once per view, so 25,000 activities take tens of milliseconds instead of several hundred.
- About 2,430 app tests (not counting the experimental `src/labs/` modules). New tests run the database upgrade on real IndexedDB (via fake-indexeddb), check that renderer-built backup snapshots pass the desktop validator byte for byte, and pin Daniels' cruise-interval reps for slow, average and fast runners.
- Date-based tests use fixed dates instead of the wall clock.
- The first-screen JavaScript budget is now 670 KiB (was 640) because the plan library loads with the app; the gzip budget (215 KiB) and the rule that charts never load on the first screen are unchanged.

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
