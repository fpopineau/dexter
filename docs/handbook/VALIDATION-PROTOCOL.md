# Validation protocol — the frozen paper sample (Phase 4)

Pre-registered BEFORE the first frozen trade, per
[REMEDIATION-2026-08-20.md](REMEDIATION-2026-08-20.md) Phase 4. This
document is the acceptance contract for going live: the numbers below
were chosen before the sample existed and do not move to fit it. The
audit's bottom line stands until this protocol passes: the burden is
positive expectancy after costs, not improved loss control.

## Freeze

- The freeze starts at git tag `validation-freeze-1` (NOT YET TAGGED —
  see prerequisites). From the tag: no rule, gate, threshold, scorer, or
  sizing changes. The 2026-08-19 discovery rules, every remediation WP,
  and the 2026-08-22 take-at-x% exit policy (WP-EXIT — `exit_style` is
  pinned at tag time; flipping it ends the window) are part of what
  freezes.
- **The sample is SHADOW-LIVE** (WP-SHADOW, operator decision
  2026-08-22): the paper account is reset to ≈$11,700 (≈€10K, the live
  target) and runs `risk-rules.live.yaml` via `DEXTER_RISK_PROFILE=live`
  — the validation trades the exact live policy at the live scale, so no
  cross-profile extrapolation survives in the evaluator. TWO documented
  deviations (2026-08-23): the fail-closed class switches
  (`swing_enabled`, `earnings_bet_enabled` — false in the live config
  until each class's own ≥30-trade record passes) are forced TRUE in
  shadow, on a paper account only, so those records can accrue.
- **Frozen policy additions (operator, 2026-08-23)**: intraday is FLAT BY
  CLOSE — the momentum-keep is gone; the only overnight path for an
  intraday position is the explicit pre-bell `keep SYMBOL` (still subject
  to the earnings guard, the whole-book overnight vet and the gap-stress
  budget), and a planned overnight is a swing proposal. One active thesis
  per symbol (any working row refuses a new proposal). Chase continuation
  defaults OFF. The whole surviving book — conversions AND deliberate GTC
  positions — is gap-stress vetted at the bell and at GTC acceptance.
- **The judgment policy freezes too** (review 2026-08-21): the runtime
  model/provider settings are pinned at tag time and recorded in the
  validation journal; every proposal stamps its `model` column, and the
  final evaluation VERIFIES the sample is single-model. A mid-sample
  model change ends the window like any behavior change.
- Confidence sizing is FLAT (multipliers 1.0) in both profiles as of
  2026-08-21 — verified in config, not just mandated here.
- Auto-execution's final floor is 0 (D6) so the decile-monotonicity
  test gets cross-band data. HONESTY NOTE (review 2026-08-21): the
  sample is still shaped upstream (trigger rank threshold, skill score
  floors, the daily cap's time-of-day bias) — floor 0 removes the last
  selection stage, it does not make sampling unbiased; the monotonicity
  result is conditional on the proposed-score range.
- At tag time the journal also records: the model AND provider strings,
  a SHA-256 of `.dexter/RULES.md` (mutable judgment input), a SHA-256 of
  `.dexter/data/performance-epoch.json` (the window's pin is a mutable
  JSON file — the fingerprint proves it never drifted; the scorecard
  prints it), the active `exit_style`, and the scorer-weights provenance
  line — `model` column homogeneity alone does not prove a homogeneous
  judgment policy.
- **The evaluator is `scripts/validation-scorecard.ts`** — its pinned
  definitions ARE this protocol's machine-readable form (sample filter,
  net P&L, profit factor, the drawdown scaling formula, per-trade
  Spearman with the t-approximation p-value, top/bottom bands at the
  sample's 80th/20th score percentiles with n ≥ 10 each, single-model
  purity incl. no-NULLs, ≥2 regime tags, ≥6 ISO weeks). Run it weekly
  and at completion; editing its definitions mid-sample ends the window.
- Bug fixes during the window are allowed ONLY for accounting
  correctness (a fill recorded wrong, a P&L mis-attributed), never for
  behavior, and each is logged in the validation journal
  (`docs/day2day/VALIDATION-JOURNAL.md`, one line per fix, with commit).
- A behavior change for any reason ENDS the window: new freeze tag, new
  sample, from zero. **This covers the research backlog too** (2026-08-23):
  scanner depth, RVOL treatment, regime routing, data-source changes and
  judgment-input changes alter discovery, ranking or selection — "not a
  deterministic gate" does not mean "safe to modify mid-sample".
- **Freeze manifest** (2026-08-23, identity model revised 2026-08-24):
  at tag time the operator commits `docs/day2day/FREEZE-MANIFEST.md`.
  Its identity model is split so nothing is self-referential (review-17):
  a **behavioral baseline commit SHA** (the last commit touching runtime
  behavior), then a docs-only manifest commit the tag points at (the
  baseline..tag diff outside docs must be empty), plus the model and
  provider strings, the SHA-256 of `.dexter/RULES.md` and of
  `performance-epoch.json`, the active `exit_style`, the scorer-weights
  provenance line, the ratified `risk-rules.live.yaml` numbers, the
  broker-behavior observation records and any recorded waivers.
- **Strategy fingerprint — the machine-checked freeze** (2026-08-24,
  widened by review-18, tree-based per review-22): every proposal row
  and every equity sample is stamped with a 12-hex digest of the
  effective risk rules + SOUL.md + `.dexter/RULES.md` + every
  discovered skill's SKILL.md + the configured provider:model pair +
  the runtime-path TREE identity (git tree/blob hashes of src/,
  scripts/ and root configs — not the commit SHA, so a docs-only
  manifest commit leaves the fingerprint unchanged)
  (`src/services/strategy-fingerprint.ts`). The scorecard REFUSES a
  window that mixes fingerprints or contains absent stamps — a
  mid-sample rules edit, profile flip, judgment-doc or skill rewrite,
  model switch or code deploy is detected by the sample itself, not by
  trusting the manifest. The manifest records the single fingerprint the
  scorecard prints; the per-trade `model` column additionally pins which
  model proposed each trade. The scorecard also verifies the one-thesis
  unique index exists (`PRAGMA index_list`) — a legacy DB where it could
  not be created has no DB-level accept exclusion and is called out.
  Operational requirements (review-20): set `provider` AND `modelId`
  EXPLICITLY in `.dexter/settings.json` before the freeze — the
  fingerprint refuses implicit defaults (null → ABSENT → window
  refused); schedule-specific model overrides are caught by the
  per-trade `model` column, a recorded residual. The gateway must run
  from a CLEAN checkout: a runtime-dirty tree fingerprints as
  `tree.<hash>+dirty.<content-hash>` and the scorecard fails the
  evaluation — the tag could not reconstruct the sampled behavior.
  Review-23 additions: the fingerprint also covers `bun.lock` (a
  dependency change is a behavior change) and a typed NON-SECRET
  snapshot of every behavior-affecting environment setting (trigger
  thresholds, auto-execution selection, EOD switches, universe
  overrides, data-feed type; API keys ride as presence flags only) —
  **EDITING `.env` MID-SAMPLE ENDS THE WINDOW**, including explicitly
  setting a variable to its default. A FINAL evaluation (`--final`, or
  automatically once the `validation-freeze-1` tag exists) requires the
  tag, reads the manifest FROM THE TAG (`git show <tag>:…` — the
  working-tree copy is mutable after tagging and is used only for
  labelled pre-tag diagnostics), and verifies the declared baseline SHA
  is an ancestor of the tag. Review-24: the final evaluation audits the
  WHOLE tagged manifest mechanically — every unfilled `_pending_`/
  `_REQUIRED`/waiver placeholder fails, the recorded tag name and
  deployable-class scope must match, and the baseline→tag diff must
  touch ONLY the manifest file. The fingerprint additionally covers the
  cron jobs (`.dexter/cron/jobs.json` behavior fields — prompt, model,
  schedule, enabled state, iteration budget), the web-search provider
  preference and all search-capability presence flags — **EDITING CRON
  JOBS MID-SAMPLE ENDS THE WINDOW**, same as `.env`.
- **The shadow swing record is EXPLORATORY** (2026-08-23): no official
  macro calendar exists yet, and adding one later changes the judgment
  inputs swings depend on. Enabling `swing_enabled` live therefore
  requires BOTH the class's own record passing its bar AND a
  swing-specific frozen sample collected AFTER any macro-calendar
  addition — the current shadow record informs, it cannot authorize.

### Prerequisites for tagging (operator checklist)

1. ✅ **VERIFIED 2026-08-21** (`scripts/verify-paper-prereqs.ts`, rerun
   any time): the provisional ×100 lot factor was WRONG — this fetch
   path returns share-denominated volume (AAPL read 3.09B/day, 100× its
   ~31M ADV, which would have let `min_avg_volume` pass almost
   anything). Factor removed, ADVs now read plausibly (AAPL 30.9M,
   NVDA 68.5M, KO 8.2M). Tick-236 field 46 (shortable) confirmed
   (AAPL/BYND true); field 49 (halted) is silent on a normal tape —
   the gate's null→note design stands. EUR.USD midpoint 1.168 ✓.
2. **OCA-joined close: paper observation REQUIRED before the tag**
   (strengthened 2026-08-23 — was "opportunistic"). The harness proves
   the transmitted fields, not IBKR's behavior when an order joins an
   already-working OCA group; a failure discovered mid-sample would be a
   behavioral fix and restart the sample. Observe one joined close
   cancelling its stop/target broker-side on paper, and record it in the
   freeze manifest.
   For the WP2 resize and WP11 buffered-events paths: prefer real paper
   observations before the tag; if they cannot reasonably be induced,
   record an EXPLICIT operator waiver (harness coverage accepted) in the
   manifest — never leave them vaguely "opportunistic".
   **Mixed-TIF bracket behavior: paper observations REQUIRED before the
   tag** (review-17). The harness pins the transmitted TIFs (DAY parent,
   GTC exits), but IBKR documents only that attached children stay held
   until the parent fills — NOT what happens to GTC children when a DAY
   parent expires, nor after a partial fill. Observe on paper: (a) an
   unfilled DAY parent expiring at the bell removes its dormant GTC
   children; (b) a fully filled DAY parent leaves both GTC exits active
   overnight; (c) a partially filled DAY parent at expiry leaves
   correctly sized protection (waivable only with the WP2 resize
   observation recorded). Record all three in the freeze manifest beside
   the OCA observation.
3. **Shadow-live CONFIGURED first (2026-08-22, ordered per review-30)**:
   operator ratifies the €10K revision of `risk-rules.live.yaml`
   (REVIEW-marked), resets the paper account NetLiq to ≈$11,700 in IBKR
   Account Management, and sets `DEXTER_RISK_PROFILE=live` in the
   gateway environment — ALL BEFORE the gateway starts. Environment
   changes do not reach an already-running gateway: booting first and
   configuring after would collect the "frozen" sample under the paper
   profile until the fingerprint mismatch surfaced.
4. One clean gateway RESTART with the configuration above: YAML
   validation passes, calendar coverage ok, no adoption-sweep
   surprises, and the boot log / scorecard CONFIRMS the live profile is
   active (the scorecard's deployable-classes line must read the live
   flags and daily-loss bar). Only then send `performance reset` — one
   clean epoch at the live scale, created by the correctly-profiled
   gateway. The scorecard fails any sample whose epoch NetLiq is not
   live-scale.
5. **Tagging procedure — the LAST step (review-27/28/29: the tag IS the
   sample clock, and the epoch must be FROZEN BEFORE it — a
   `performance reset` after the tag changes the epoch hash the
   manifest recorded and the scorecard rejects it).** Only after steps
   1–4 are complete and every observation is recorded: fill the
   manifest (its epoch SHA-256 row must hash the FINAL, post-reset
   `performance-epoch.json`), commit it (docs-only over the baseline),
   then IMMEDIATELY (within 10 minutes — the scorecard enforces the
   tolerance against the manifest's `Tagged at (UTC)` row) create an
   ANNOTATED tag:
   `git tag -a validation-freeze-1 -m "validation freeze"`
   The tag's TAGGER timestamp — not the commit's — is the sample window
   start; a lightweight tag fails the final evaluation. Then anchor it
   immutably: `git push origin validation-freeze-1` — the pushed remote
   copy is MANDATORY (the final evaluation machine-compares the remote
   tag object and fails without it); enable tag protection on the
   remote. Record the tag-OBJECT sha
   (`git for-each-ref --format="%(objectname)" refs/tags/validation-freeze-1`)
   in the validation journal, and run the scorecard once — its FIRST
   SIGHTING pins the tag-object sha to
   `.dexter/data/freeze-tag-pin.json`, and every later evaluation fails
   if the tag was force-moved to a different object. Never retag: a
   moved tag is a broken freeze anchor, window from zero.

## Sample definition

- **Size**: at least 100 closed, entry-filled, non-adopted trades with
  resolved P&L (`realized_pnl NOT NULL`, `exit_reason NOT IN
  ('cancelled')`, `source != 'adopted'`), counted from the freeze tag's
  timestamp. Rows flagged untrustworthy in `note` are excluded.
- **Breadth**: the sample must span at least 2 distinct market-regime
  labels (the regime service's tags recorded at proposal creation) and
  at least 6 distinct calendar weeks. A sample that reaches 100 trades
  inside one regime keeps collecting until breadth is met.
- **Integrity gate**: zero unresolved fill/reconciliation anomalies at
  evaluation time — no `placement-unconfirmed` rows older than a day, no
  orphan-order flags outstanding, adoption sweep clean. An anomaly
  freezes the evaluation, not the collection.

## Acceptance criteria (ALL must hold)

(Revised 2026-08-22/23, BEFORE the tag — the sample does not exist yet, so
these are still pre-registered numbers, not fitted ones.)

**Scope — the deployable book.** Every criterion below is computed over
the classes ENABLED in `risk-rules.live.yaml` (the scorecard reads the
flags — the verdict's scope IS the deployable config). Earnings bets run
in shadow-live only to build their per-class record; they are reported
apart and NEVER carry (or sink) the verdict.

**Provenance (REQ-VAL-010).** Sample rows must come from a known
production lane and carry broker execution identity (WP1 permIds);
`test`/`smoke`/`adopted` sources never qualify, and an unrecognized
source freezes the evaluation. (A test-isolation failure on 2026-08-23
put 12 synthetic rows into the real DB — cleaned, and the runners now
isolate unconditionally with a temp-dir-only guard, REQ-TEST-001.)

0. **Live scale**: the frozen epoch NetLiq must sit inside ±10% of the
   $11,700 live target — the sample must have been collected at the scale
   it predicts (whole-share selection, concentration, commissions all
   change with scale). A $49K or $4K sample fails outright.
1. **Net expectancy > 0**: mean net P&L per trade (gross − commissions)
   strictly positive.
2. **Expectancy lower bound > 0**: the 95% one-sided lower confidence
   bound of mean net P&L per trade, from a day-block bootstrap clustered
   by ENTRY cohort (entry days resampled with replacement, 1000
   replicates, seed 42 — trades entered the same session share the tape,
   the regime and the catalyst), strictly positive. A sample mean carried
   by one fat day is not expectancy.
3. **Profit factor ≥ 1.3**: gross wins / |gross losses| on net-of-
   commission trade P&L.
4. **Portfolio drawdown inside the live math**: the worst peak-to-trough
   of MARKED NetLiq (the gateway's 5-minute equity series, SEEDED with the
   frozen epoch NetLiq so a loss before the first sample cannot vanish,
   and ADJUSTED by cumulative realized shadow-class P&L so an experimental
   winner cannot mask a deployable trough) must not exceed 2× the live
   `max_daily_loss_pct` — with the series proving it WATCHED every
   exposure interval across the EXTENDED session (04:00–20:00 ET, where
   overnight gaps materialize; first/last-sample and 20-minute max-gap
   requirements; violations make the criterion NOT EVALUABLE).
   Closed-trade drawdown is informational only. Recorded caveat:
   unrealized in-flight shadow-bet distortion remains, bounded by the
   1-bet budget cap; account separation stays on the live-gate backlog.
5. **Class discipline (enforced via config)**: every class ENABLED in
   `risk-rules.live.yaml` must clear its own floor — ≥30 trades,
   net-positive, profit factor ≥ 1.3 AND a positive entry-cohort
   bootstrap LCB — or the verdict FAILS; the remedy is disabling the
   class (`swing_enabled` / `earnings_bet_enabled`, which the gate
   enforces) or collecting more. Disabled classes earn their enable
   decision on their own shadow record against the SAME bar, reported
   per class, flipped only by a deliberate journal-recorded operator act.
6. **Cohort completeness (no right-censoring)**: the FINAL evaluation
   freezes intake and refuses to PASS while any in-cohort trade (entered
   inside the window, still working) remains open — a closed-only sample
   can reach 100 winners while the slow losers sit open and excluded.

**Hypothesis, not fix.** The take-at-x% exit policy that freezes with this
sample is an explicit experimental hypothesis ("better now than later",
2026-08-22), not a demonstrated improvement: it replaces a ratio-derived
target with an ATR-derived one. The post-exit MFE and legacy-geometry
counterfactual columns exist so the sample can say whether it paid;
the multiplier is not to be retuned mid-sample.

## Score calibration (separate switch)

Confidence-weighted sizing (`sizing_full_score` bands) stays at a FLAT
multiplier until, on the same frozen sample:

- score deciles are monotone in mean net P&L (Spearman rank correlation
  > 0 with p < 0.05 across trades with recorded scores), and
- the top score band's win rate exceeds the bottom band's.

Fails → sizing stays flat on live; the scorer keeps collecting.

## Evaluation mechanics

- The weekly scorecard (benchmark extension) publishes the running
  sample: n, net expectancy, profit factor, drawdown, per-class and
  per-lane splits, score-decile table. Drift from this protocol must be
  visible weekly, not remembered at the end.
- Final evaluation is a one-shot read-only query over `proposals.db` at
  sample completion, checked against every criterion above, recorded in
  the validation journal with the query text.
- PASS → the live-account switch proceeds per
  [live-account plan] with `IBKR_ALLOW_LIVE` flipped only after the
  operator re-reads `risk-rules.live.yaml`.
- FAIL any criterion → no live. Diagnose, change deliberately, re-tag
  (`validation-freeze-2`), collect a fresh sample. Partial credit does
  not exist; nearly passing is failing.

## Never

- Never evaluate mid-sample and stop early on a good stretch (peeking
  is selection bias in time).
- Never widen a criterion to fit the sample after the fact.
- Never count adopted, cancelled-annotated, or pre-freeze rows.
- Never flip `earnings_bet_enabled` on live from this protocol alone —
  the class needs its own ≥30-trade shadow record per criterion (5), and
  it is never part of the deployable verdict.
