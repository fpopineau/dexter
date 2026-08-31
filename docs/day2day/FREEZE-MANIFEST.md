# Freeze manifest — validation-freeze-1

TEMPLATE (2026-08-24, review-17 model) — the operator fills and commits
this AT TAG TIME. It is the immutable record the final evaluation is
checked against (VALIDATION-PROTOCOL.md). A field left `_pending_` means
the tag has not happened.

## Identity model (review-17: no self-reference)

The manifest cannot contain the SHA of the commit that contains it. The
freeze identity is therefore split:

1. **Behavioral baseline commit** — the last commit that changes ANY
   runtime behavior (src/, scripts/, config yamls, SOUL.md, skills,
   `.dexter/RULES.md`). Recorded below by SHA; it exists BEFORE the
   manifest commit.
2. **Manifest commit** — a commit on top of the baseline that changes
   ONLY this file (review-18: excluding all Markdown would hide SOUL.md
   and skill edits).
   `git diff <baseline>..<tag> -- ':!docs/day2day/FREEZE-MANIFEST.md'`
   must be EMPTY (verify before tagging; a non-empty diff means the
   baseline is wrong).
3. **Tag** — `validation-freeze-1` placed on the manifest commit.
4. **Strategy fingerprint** — the machine-checked half. Every proposal
   row and equity sample is stamped with a 12-hex digest of: the
   effective risk rules, SOUL.md, `.dexter/RULES.md`, every discovered
   skill's SKILL.md (built-in and project), the configured
   provider:model pair, and the RUNTIME-PATH TREE identity
   (src/services/strategy-fingerprint.ts). Review-22: the code half is
   the git tree/blob hashes of src/, scripts/ and the root runtime
   configs — NOT the commit SHA — so committing THIS manifest (a
   docs-only commit) leaves the fingerprint it records unchanged; the
   self-reference is resolved by construction. The scorecard REFUSES a
   window that mixes fingerprints or contains absent stamps, compares
   sample = current = manifest three ways, and once the tag exists (or
   with `--final`) a missing manifest fingerprint FAILS the evaluation.
   The per-trade `model` column additionally pins which model proposed
   each trade.

| Field | Value |
|---|---|
| Freeze tag | _pending_ |
| Behavioral baseline commit SHA | _pending_ |
| Manifest commit docs-only diff verified | _pending_ (command above, operator initials) |
| Tagged at (UTC) | _pending_ |
| Model string | _pending_ |
| Provider string | _pending_ |
| `exit_style` | _pending_ |
| Strategy fingerprint (scorecard prints it) | _pending_ |
| SHA-256 of `.dexter/RULES.md` | _pending_ |
| SHA-256 of `performance-epoch.json` | _pending_ (the scorecard prints it) |
| Epoch NetLiq (frozen denominator) | _pending_ (must be $11,700 ±10%) |
| Scorer-weights provenance | _pending_ |
| `risk-rules.live.yaml` ratified | _pending_ (operator initials + date) |

## Broker-behavior observations (prerequisite 2)

| Path | Status |
|---|---|
| OCA-joined close cancels its siblings broker-side | observed 2026-08-28 S EOD close joined the exit OCA group; close fill broker-cancelled the sibling exit #17 #18 #19 #23 (operator-accepted; in-position, the row's literal close-join variant — the exit-fill variant was also witnessed 2026-08-26 BZ #1 #2 #3) |
| Mixed-TIF bracket: unfilled DAY parent expiry removes the dormant GTC children | _REQUIRED — record the paper observation (review-17: IBKR documents children held until the parent fills; expiry behavior is NOT documented)_ |
| Mixed-TIF bracket: fully filled DAY parent leaves both GTC exits active overnight | _REQUIRED — record the paper observation_ |
| Mixed-TIF bracket: PARTIALLY filled DAY parent at expiry leaves correctly sized GTC protection | _observation or explicit waiver (hard to stage on demand; waive only with the partial-fill resize (WP2) observation recorded)_ |
| WP2 partial-fill resize | _observation or explicit waiver_ |
| WP11 buffered finalize events | _observation or explicit waiver_ |

## Value grammar (review-25 — the final audit parses these MECHANICALLY)

- Every `_pending_` / `_REQUIRED` / `_observation or explicit waiver…_`
  placeholder must be REPLACED; any survivor fails the final evaluation.
- Identity rows: `Strategy fingerprint` = exactly the 12-hex value the
  scorecard prints; `Behavioral baseline commit SHA` = the 40-hex SHA;
  the SHA-256 rows must contain the 64-hex digest; `exit_style` =
  `target` or `ratchet`.
- Broker-observation rows must BEGIN with a status word the audit
  matches: `observed YYYY-MM-DD SYMBOL <details>` for a real
  observation (a REAL calendar date, a ticker-shaped symbol, and — on
  the OCA and mixed-TIF rows — at least THREE DISTINCT broker order ids
  like `#100/#101/#102`: the parent/close plus the target and stop
  legs; distinctness is NUMERIC, so `#1/#01/#001` counts as one), or
  `WAIVED <initials>: <reason>` (exactly `WAIVED`, uppercase) where the
  protocol allows a waiver (WP2, WP11, and the partial-expiry row only
  with the WP2 row observed). `not observed`, blanks, and any other
  phrasing fail. The OCA row and the first two mixed-TIF rows are NOT
  waivable.
- The tag must be ANNOTATED (`git tag -a validation-freeze-1 -m …`) —
  its tagger timestamp IS the sample window start; a lightweight tag
  fails the final evaluation. `Tagged at (UTC)` must match the tagger
  timestamp within 10 minutes: create the tag right after committing
  this manifest.
- Deleting a row does not bypass the audit — a missing required row is
  its own failure.

## Notes

- Any behavior change after the tag ends the window (protocol Freeze
  section) — including research-backlog changes to discovery/ranking.
  The strategy fingerprint makes rule/judgment drift self-reporting; a
  code change requires a new baseline SHA and therefore a new window.
- The deployable verdict scope at tag time: the classes enabled in
  `risk-rules.live.yaml` (record them here): _pending_.
