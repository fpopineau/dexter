# Freeze manifest — validation-freeze-1

TEMPLATE (2026-08-23) — the operator fills and commits this AT TAG TIME.
It is the immutable record the final evaluation is checked against
(VALIDATION-PROTOCOL.md). A field left `_pending_` means the tag has not
happened.

| Field | Value |
|---|---|
| Freeze tag | _pending_ |
| Commit SHA at tag | _pending_ |
| Tagged at (UTC) | _pending_ |
| Model string | _pending_ |
| Provider string | _pending_ |
| `exit_style` | _pending_ |
| SHA-256 of `.dexter/RULES.md` | _pending_ |
| SHA-256 of `performance-epoch.json` | _pending_ (the scorecard prints it) |
| Epoch NetLiq (frozen denominator) | _pending_ (must be $11,700 ±10%) |
| Scorer-weights provenance | _pending_ |
| `risk-rules.live.yaml` ratified | _pending_ (operator initials + date) |

## Broker-behavior observations (prerequisite 2)

| Path | Status |
|---|---|
| OCA-joined close cancels its siblings broker-side | _REQUIRED — record the paper observation (date, symbol, order ids)_ |
| WP2 partial-fill resize | _observation or explicit waiver_ |
| WP11 buffered finalize events | _observation or explicit waiver_ |

## Notes

- Any behavior change after the tag ends the window (protocol Freeze
  section) — including research-backlog changes to discovery/ranking.
- The deployable verdict scope at tag time: the classes enabled in
  `risk-rules.live.yaml` (record them here): _pending_.
