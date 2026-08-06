# Dexter Day2Day — Handbook

Reference documentation for the day/overnight trading system — the
mission of this fork — built on [Dexter](https://github.com/virattt/dexter)
(branch `day2day`).

| Document | What it covers |
|---|---|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | The full system design: layers, components, data flow, the proposal lifecycle, the safety model, storage layout, and the design rationale behind each choice. |
| **[DATA-SOURCES.md](DATA-SOURCES.md)** | Every data source the system uses or plans to use: what is wired, what it feeds, how to configure it, what is still missing and why it matters. |
| **[USER-MANUAL.md](USER-MANUAL.md)** | Day-to-day operations: setup, running the gateway, the WhatsApp command reference, scheduled briefs, calibration, backtesting, monitoring, troubleshooting, and the go-live checklist. |

Companion documents (design history, kept for context):

- [../day2day/PLAN.md](../day2day/PLAN.md) — the original architecture plan
  and phase tracker, including the ML roadmap (phases 6–8).
- [../day2day/AUTOMATION.md](../day2day/AUTOMATION.md) — the condensed
  system reference for the automation pipeline.

Research memos (external work analyzed for reuse):

- [../day2day/RESEARCH-signal-or-noise.md](../day2day/RESEARCH-signal-or-noise.md)
  (added 2026-08-05) — analysis of Fatouros & Metaxas,
  ["Signal or Noise in Multi-Agent LLM-based Stock Recommendations?"](https://arxiv.org/abs/2604.17327)
  (arXiv:2604.17327; PDF in Zotero), and six reuse options for day2day —
  headline: a counterfactual same-size null over the engine's candidate
  pool (R1, needs a `snapshotId` on proposals) to test whether the LLM
  judgment layer beats the deterministic scanner net of costs.
- [../day2day/RESEARCH-screening.md](../day2day/RESEARCH-screening.md)
  (added 2026-08-05) — day/overnight stock-screening methods and whether a
  home-built screener can beat the IBKR scanner. Verdict: yes, on breadth,
  composability and historizability; latency-tiered hybrid (IBKR RT top-N +
  $29–$99/mo full-market snapshots) with evidence-backed criteria
  (overnight/intraday decomposition, attention-reversal, short-flow).
- [../day2day/RESEARCH-news-gdelt-polymarket.md](../day2day/RESEARCH-news-gdelt-polymarket.md)
  (added 2026-08-05) — usability of GDELT news and Polymarket/Kalshi
  probabilities as signals. Verdict: GDELT stock-level stays in backtest
  behind the entity-mapper + a pre-registered IC gate; prediction markets
  enter as episodic event-window context (briefs, overnight gap risk), not
  as a scoring factor; two zero-cost data accruals to start now.

## One-paragraph overview

Dexter's agent loop, tool registry, skills, memory and WhatsApp gateway are
extended into a **quasi-automatic trading system** with a strict division of
labor: a deterministic **Opportunity Engine** continuously scans and ranks
the market through IBKR (no LLM, no cost); an **LLM judgment layer** runs
only on schedules and events, verifying catalysts and registering **trade
proposals**; execution is **human-gated** (a WhatsApp reply or a TUI
approval) and passes four independent safety gates before a paper bracket
order is placed; an **outcome tracker** then records how every trade ended
— fills, exit reason, realized P&L — closing the feedback loop that
performance reporting, calibration and the future ML pipeline are built on.

## Quick start

```bash
cp env.example .env            # fill in IBKR_*, one LLM key, one search key
bun install
bun run gateway:login          # pair WhatsApp (QR code)
bun run gateway                # engine + briefs + triggers + tracker + archive
```

Then message the bot on WhatsApp: `proposals`, `halt status`, `performance`.
Full setup details in the [user manual](USER-MANUAL.md).
