# Repository Guidelines

- Repo: https://github.com/virattt/dexter (this fork: the `day2day` trading mission)
- Dexter is a day/overnight **trading agent**: an LLM judgment layer that proposes trades, wrapped in deterministic risk machinery that a human — never the model — ultimately unlocks. TypeScript, LangChain, a custom terminal UI (`@mariozechner/pi-tui`), a WhatsApp gateway, and Interactive Brokers for market data and (gated) execution.

## Mission Documents — read these first

- `SOUL.md` — the agent's identity and trading philosophy. Loaded into the system prompt at runtime; edits change live behavior.
- `src/config/risk-rules.yaml` — every risk number the gates enforce. `risk-rules.live.yaml` overlays it when a non-paper account is detected (smaller book, earnings bets disabled).
- `docs/handbook/` — ARCHITECTURE (design + safety model), USER-MANUAL (operations, proposal lifecycle, kill-switch, go-live checklist), DATA-SOURCES (what's wired, what's plan-blocked).
- `docs/day2day/PLAN.md` — the original build plan; useful history, superseded where the handbook disagrees.
- `.dexter/RULES.md` (runtime, gitignored) — the operator's standing trading rules, injected into the system prompt.

## The Trading Model

- **Three trade classes** (`src/tools/ibkr/risk-rules.ts` → `TradeClass`): `intraday` (default; stop-distance sizing), `swing` (pattern trades up to ~2 weeks, GTC, max 3, own budget), `earnings-bet` (deliberate hold through one print, max 1, sized to the **worst historical post-print gap**, not the stop; `earnings_bet_enabled: false` in the live profile until the class has a proven paper record).
- **Proposal lifecycle** (`src/services/trade-proposals.ts`): `open → executing → executed → closed` (or `rejected/expired/failed`). The LLM may create; a human accept, or the auto-executor, places the bracket — on paper behind `AUTO_EXECUTE_PAPER`, on a live account only behind `IBKR_ALLOW_LIVE`, the operator's challenge-confirmed live switch (`live on <token>`; the system writes only OFF), a running epoch and the veto window (`docs/handbook/TRADING-POLICY.md`). The risk gate (`proposal-risk-gate.ts`) runs at creation AND acceptance; class caps are counted server-side from the DB so callers cannot understate the book.
- **Sizing** (`src/services/position-sizer.ts`): quantity = risk budget × confidence ÷ risk-per-share, whole shares, refuse-don't-shrink. Never bypass it by passing explicit quantities in generated code.
- **Safety invariants** (do not weaken in any change): the paper/live lock (`IBKR_ALLOW_LIVE`), the kill-switch, interactive approval on `accept_proposal` / `ibkr_orders`, mandatory stops, the `NODE_ENV=test` guard that refuses to open the production proposals DB, and gates that outrank the model.

## Project Structure

- `src/agent/` — agent loop, system prompts (`prompts.ts`, channel profiles in `channels.ts`), compaction (`compact.ts` — note the mandatory "Open Trade State" summary section), scratchpad
- `src/gateway/` — WhatsApp channel, cron-driven briefs (`src/cron/trading-schedules.ts`), heartbeat (positions-vs-stops monitor), triggers, proposal commands
- `src/services/` — the deterministic machinery: proposal store/gate/sizer/executor, outcome tracker, profit trail, daily-loss guard, EOD triage, opportunity engine, pattern scanner + detectors (pullback / flat base / cup-and-handle), earnings calendar, earnings reactions (post-print record + evidence bar), benchmark ledger, data archive
- `src/tools/` — LangChain tools; `registry.ts` decides what the model sees (IBKR tools gated on `IBKR_HOST`/`IBKR_PORT`). Notable: `ibkr/` (market data, historical, orders, scanner, TA, signal scorer, risk manager, implied move), `proposals/`, `earnings/` (calendar + `earnings_bet_intel`), `finance/` (present-state fundamentals; plan-limited), `search/`, `subagent/` (catalyst + setup-validation workers)
- `src/skills/` — SKILL.md workflows, auto-discovered and injected into the system prompt: `pre-market`, `day-trade`, `overnight`, `earnings-bet`, `company-snapshot`, `x-research`
- `src/components/`, `src/controllers/`, `src/cli.ts` — terminal UI; entry `src/index.tsx`
- `src/backtest/` — replay engine + metrics; `src/model/llm.ts` — multi-provider LLM abstraction
- `scripts/` — smoke tests, bar backfill, scorer calibration

## Build, Test, and Development Commands

- Runtime: Bun (primary). `bun install`, `bun run start` (TUI), `bun run gateway` (full trading loop), `bun run dev` (watch)
- Type-check: `bun run typecheck` · Tests: `bun test` (CI runs both on push/PR)
- Tests are colocated `*.test.ts`; the trading machinery has deterministic scenario suites (`trade-classes.test.ts`, `proposal-risk-gate.test.ts`, `position-sizer.test.ts`, `earnings-reactions.test.ts`, `pattern-detectors.test.ts`). Touch the machinery → extend the scenarios.
- Judgment quality is NOT unit-tested; the nightly benchmark ledger measures it. Do not add LLM-in-the-loop tests.

## Coding Style & Conventions

- TypeScript, ESM, strict mode; prefer strict typing, avoid `any`.
- Keep files concise; extract helpers rather than duplicating code.
- Comments state constraints the code can't show (see the gate/sizer files for the house style — decisions carry their live-incident rationale).
- Do not add logging unless explicitly asked. Do not create README or documentation files unless explicitly asked.
- Money math: whole shares, `Math.round(x*100)/100` for dollars, refusals over silent adjustment.

## LLM Providers

- Supported: OpenAI (default `gpt-5.5`), Anthropic, Google, xAI, OpenRouter, Ollama/vLLM (local). Prefix-based provider detection in `src/model/llm.ts`; fast-model map for lightweight calls; Anthropic prompt caching via `cache_control`.
- Users switch via `/model` in the TUI; cron jobs may pin a model per schedule.

## Environment Variables

- LLM: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`; local: `OLLAMA_BASE_URL`, `VLLM_BASE_URL`
- IBKR: `IBKR_HOST`, `IBKR_PORT` (4002 paper), `IBKR_CLIENT_ID`, `IBKR_MARKET_DATA_TYPE` (3 = delayed), `IBKR_ALLOW_LIVE` (keep `false`)
- Search: `EXASEARCH_API_KEY` (preferred), `PERPLEXITY_API_KEY`, `TAVILY_API_KEY`, `LANGSEARCH_API_KEY`
- Optional: `FINANCIAL_DATASETS_API_KEY` (plan-limited — a circuit breaker handles 401/402/403), `AUTO_EXECUTE_PAPER`
- Full reference: `env.example`. Never commit `.env` or real keys.

## Version & Release

- CalVer `YYYY.M.D`, tag prefix `v`; `bash scripts/release.sh [version]` bumps, tags, and creates the GitHub release via `gh`.
- Do not push or publish without user confirmation.

## Security

- API keys in `.env` (gitignored); runtime state in `.dexter/` (gitignored) — settings, proposals DB, memory, logs, scratchpads.
- Never commit or expose real API keys, tokens, or credentials.
- Never place orders, accept proposals, or weaken a gate from generated code or tests. Tests must set `DEXTER_DATA_DIR` to a temp dir before importing the proposal store.
