# `src/labs/`: experimental modules (not part of the app)

These modules are **not wired into Apollo**. No screen, hook or app service imports them, and `src/__tests__/labsBoundary.test.ts` fails the build if one does. They were moved here from `src/services/` in v1.0.7 (R-14 / PX-10) because:

- no screen uses them, so the README and release notes shouldn't count them as features, and their tests shouldn't count toward the app's test total;
- several contain **known-wrong or unsafe advice**. Some are listed as P0 *if wired*, because they'd give runners harmful hydration, fueling or pacing guidance.

> [!IMPORTANT]
> **Before any screen uses a labs module**, fix every issue listed for it below, add tests that pin the fix, then move it back to `src/services/`. Don't import it from here. The boundary test blocks that on purpose.

Issue IDs refer to the v1.0.7 reviews: nutrition (N-), race logistics (L-), race science/analytics (A-), privacy (U-) and the training-engine review (T-).

| Module | What it was meant to do | Known problems (fix before use) |
|---|---|---|
| `hydrationCalculator` | Sweat rate, fluid plan per aid station, dehydration risk | **Unsafe:** the risk assumes zero intake, so every 40–65 °F case is "high", which triggers "aggressive hydration… every aid station" (N-02). The "% loss" quotes the no-drink figure (N-03). Sweat sodium of 450 mg/L is too low, and there's no sodium guidance (N-19). A "safe max 1000 ml/h" mis-frames hyponatremia risk; it should cap relative to sweat rate, ≤ 800 ml/h (N-20). Unsorted aid stations misallocate fluid (N-21). 26.2 mi is hard-coded (N-15). Unit/doc mismatches (N-28). |
| `glycogenModel` | Mile-by-mile glycogen depletion and "will it last" | **Unsafe:** the carb fraction is too high, predicting a bonk at mile 15 (mile 19 even at 60 g/h) (N-04). %VO2max comes from a speed ratio (N-05). Fixed stores while burn scales with weight (N-07). Fractional-mile fuel is dropped (N-08). No exogenous-oxidation cap: stores reach 159% (N-09). No input validation: NaN reads as "sufficient" (N-10, N-29). |
| `bonkRisk` | Bonk-risk score and mitigations | An easy long-run pace is flagged "aggressive" and the runner is told to slow the goal (N-06). Zero planned long runs are scored as missed (N-22). Weights aren't renormalized (N-23). The fueling-practice ratio can reach 300% (N-24). Distance-only thresholds (N-25). "Take water at every aid station" copy (N-26). Ignores the fueling plan and glycogen model (N-27). |
| `aerobicDecoupling` | Pa:HR decoupling / efficiency factor | **Graduated (`src/services/aerobicDecoupling.ts`).** Fixed EF sign (`speed ÷ HR`), trailing partial-split drop, `m/min/bpm` unit labeling, and continuous steady-state gating (A-02, A-18, A-21, A-26); pinned in `src/__tests__/aerobicDecoupling.test.ts` and wired into Progress → Heart Rate. Re-export stub kept here for legacy labs suites. |
| `postRaceAnalysis` | Post-race grade, splits and pacing report | **Science fixes complete; kept in `src/labs/` until a Post-Race screen is wired (R-14).** Distance-weighted partial splits (L-23), faster-than-goal grading (L-24), exact 50% half-marathon interpolation (L-25), signed segment deltas (L-26), report upsert by `activityId` (L-27), empty/single-split guards (L-28), honest takeaways (L-29), and `elapsed_time` + GPS overdistance reporting (L-30) are implemented and pinned in `src/labs/__tests__/postRaceAnalysis.l23-30.test.ts`. |
| `ghostRunner` | Compare a run against a past "ghost" | The partial split is counted as a full mile (L-32). **Crashes with 0 splits** (L-33). Mile-only, with raw seconds/dates in messages (L-34). No similarity guard (L-35). |
| `whatIfSimulator` | "What if I ran more / tapered / lost weight" race-time scenarios | The baseline came from the old VDOT→marathon power law; re-verify against the fixed `racePrediction` (A-01/A-03). A taper volume cut always reads "slower" (A-04). The "lose 5 lb" preset uses a shoe-mass citation (A-05). Mileage ignored, detraining persists, invented confidence (A-06…A-08). |
| `fatigueResistance` | Fatigue-resistance index from splits | The partial split skews the FRI (112.5 "severe" → 99.8 "excellent") (A-18). Split count used as distance, plus unit issues (A-15…A-17). Pace-only "durability" (A-29). |
| `pacingDecay` | Fit a pace-decay curve and predict race pacing | Negative decay predicts acceleration (mile 26 at 6:53 from 8:00). The "ideal" fade is invented (A-15…A-17). Partial split not dropped (A-18). |
| `raceEquivalence` | Normalize race times across course and weather | One-way course adjustment (flat → hilly = −5:36). Humidity applied without temperature (A-09, A-10). |
| `runningEconomy` | Efficiency trends and an "overtraining" alert | The "overtraining" alarm fires on 3 declining weekly means: 17.8% false positives on noise (A-22). EF mislabeled (A-21). Day-of-year is off by one across DST (`Math.floor(ms/86400000)`) (T-22). |
| `weather` | Open-Meteo forecast and heat adjustments | **Unsafe copy:** "Increase fluid intake to 150–200%" (~line 279). **Privacy:** fetches even when disabled (U-09); the CSP would also block it. The humidity penalty applies in the cold and isn't Ely-based (U-14). U-15…U-17 still open. |
| `shoeTracker` | Shoe mileage tracking (gear) | **Graduated (`src/services/shoeTracker.ts`).** Reviewed `mi`/`km` conversion, local-date comparison, hidden-activity exclusion, and race-day wear projection; pinned in `src/__tests__/shoeTracker.test.ts` and wired into Activities (`ShoeGaragePanel` + activity detail). Re-export stub kept here for legacy labs suites. |
| `garmin` | Direct Garmin Connect sync (partner Developer Program, OAuth) | **Superseded in v1.0.8.** Direct Garmin sync now ships in the app through Garmin's Personal API (`src/services/garmin.ts`, desktop only), and the `garmin:*` IPC handlers serve that client (`electron/garminProxy.ts`). This stub is kept for reference only; don't wire it up. |

## Tests

Tests for these modules live in `src/labs/__tests__/`. They still run with `npm test` (vitest collects `src/**`), but **report them separately** from the app's test count:

```bash
npx vitest run src/labs     # labs only
npx vitest run --exclude 'src/labs/**'   # the app
```

`edgeCaseStress.labs.test.ts` and `scientificValidation.labs.test.ts` are the labs halves of the two mixed suites. The app halves stay in `src/__tests__/`. A green labs suite does **not** mean a module is safe: several tests were written to the buggy behaviour above.

## Rules

1. App code (pages, components, hooks, services, `App.tsx`, `main.tsx`) must not import from `src/labs/`.
2. Labs modules may import app services and types, not the other way round.
3. To graduate a module: fix its listed issues, add tests that would have caught them, move it back to `src/services/`, update this table, then build the screen.
