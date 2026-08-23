# Freeze manifest — validation-freeze-1

TEMPLATE (2026-08-24, review-17 model) — the operator fills and commits
this AT TAG TIME. It is the immutable record the final evaluation is
checked against (VALIDATION-PROTOCOL.md). A field left `_pending_` means
the tag has not happened.

## Identity model (review-17: no self-reference)

The manifest cannot contain the SHA of the commit that contains it. The
freeze identity is therefore split:

1. **Behavioral baseline commit** — the last commit that changes ANY
   runtime behavior (src/, scripts/, config yamls, SOUL.md,
   `.dexter/RULES.md`). Recorded below by SHA; it exists BEFORE the
   manifest commit.
2. **Manifest commit** — a docs-only commit on top of the baseline that
   fills this file. `git diff <baseline>..<tag> -- ':!docs' ':!*.md'`
   must be EMPTY (verify before tagging; a non-empty diff means the
   baseline is wrong).
3. **Tag** — `validation-freeze-1` placed on the manifest commit.
4. **Strategy fingerprint** — the machine-checked half. Every proposal
   row and equity sample is stamped with a 12-hex digest of the effective
   risk rules + SOUL.md + `.dexter/RULES.md`
   (src/services/strategy-fingerprint.ts). The scorecard REFUSES a
   window that mixes fingerprints or contains absent stamps, so runtime
   rule/judgment drift mid-sample is detected without trusting this
   document. Code drift is git's job (baseline SHA); model drift is the
   per-trade `model` column's job.

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
| OCA-joined close cancels its siblings broker-side | _REQUIRED — record the paper observation (date, symbol, order ids)_ |
| Mixed-TIF bracket: unfilled DAY parent expiry removes the dormant GTC children | _REQUIRED — record the paper observation (review-17: IBKR documents children held until the parent fills; expiry behavior is NOT documented)_ |
| Mixed-TIF bracket: fully filled DAY parent leaves both GTC exits active overnight | _REQUIRED — record the paper observation_ |
| Mixed-TIF bracket: PARTIALLY filled DAY parent at expiry leaves correctly sized GTC protection | _observation or explicit waiver (hard to stage on demand; waive only with the partial-fill resize (WP2) observation recorded)_ |
| WP2 partial-fill resize | _observation or explicit waiver_ |
| WP11 buffered finalize events | _observation or explicit waiver_ |

## Notes

- Any behavior change after the tag ends the window (protocol Freeze
  section) — including research-backlog changes to discovery/ranking.
  The strategy fingerprint makes rule/judgment drift self-reporting; a
  code change requires a new baseline SHA and therefore a new window.
- The deployable verdict scope at tag time: the classes enabled in
  `risk-rules.live.yaml` (record them here): _pending_.
