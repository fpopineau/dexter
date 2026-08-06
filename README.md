# Dexter 🤖

Dexter is a day/overnight trading agent that lives in a terminal. It scans, evaluates catalysts, and proposes trades with explicit entry/stop/target and a computed size — then a human says yes or no. The judgment comes from an LLM; the discipline comes from deterministic machines the LLM cannot override: risk gates, a position sizer, a profit trail, an end-of-day triage, and a nightly benchmark that measures the calls against the market.

Who Dexter is — voice, values, and how it thinks about risk — lives in [SOUL.md](SOUL.md). The engineering reference lives in [docs/handbook/](docs/handbook/README.md).

<img width="665" height="452" alt="Dexter TUI" src="https://github.com/user-attachments/assets/02418111-5f48-4a66-be5d-dc9bf9806284" />

## Table of Contents

- [⚠️ Disclaimer](#%EF%B8%8F-disclaimer)
- [👋 Overview](#-overview)
- [✅ Prerequisites](#-prerequisites)
- [💻 How to Install](#-how-to-install)
- [🚀 How to Run](#-how-to-run)
- [🧪 How to Test](#-how-to-test)
- [🐛 How to Debug](#-how-to-debug)
- [📱 How to Use with WhatsApp](#-how-to-use-with-whatsapp)
- [🛡️ Safety Model](#%EF%B8%8F-safety-model)
- [🤝 How to Contribute](#-how-to-contribute)
- [📄 License](#-license)

## ⚠️ Disclaimer

Dexter is a **personal trading system**. It proposes trades; a human accepts them. Real-money execution exists, and it sits behind explicit safety gates — a paper/live lock, interactive approval on every order, deterministic risk rules, and a kill-switch.

- Nothing produced by this software is financial, investment, tax, or legal advice
- No guarantees of accuracy, completeness, or fitness for any purpose — outputs can be wrong, stale, or incomplete
- Trading involves substantial risk of loss; past performance does not indicate future results
- The author and contributors assume no liability for any losses or damages

If you run this, you are trading your own account under your own judgment, entirely at your own risk.

## 👋 Overview

Dexter trades **moves, not businesses** — at a horizon of hours to a few nights, stretched to ~2 weeks for swing patterns. Financial data is used only to understand the present state of a company, never for long-term valuation.

**Three trade classes**, each with its own risk budget and caps enforced by a deterministic gate:

| Class | Horizon | Sizing basis |
|---|---|---|
| `intraday` | hours to a few nights | stop distance vs the per-trade risk budget |
| `swing` | up to ~2 weeks (pullback / flat base / cup-and-handle), max 3 open | stop distance vs the swing budget |
| `earnings-bet` | deliberately through one earnings print, max 1 open | the **worst historical post-print gap** — a stop cannot protect through a print |

**Key capabilities:**
- **Deterministic risk machinery**: creation- and acceptance-time risk gates, confidence-weighted position sizer, noise-stop and extension (anti-chasing) filters, daily-loss guard, profit trail that lets winners run, EOD triage
- **Proposal lifecycle**: every idea becomes a persisted proposal (`open → executed → closed`) with entry/stop/target/size; the LLM can create, only a human can accept; outcomes are tracked and reported per class — losses included
- **Scanning**: IBKR scanners and a continuous opportunity engine for intraday; a nightly swing-pattern scan (pullback, flat base, cup-and-handle) over the midcap universe
- **Earnings machinery**: calendar (who reports, when), a per-symbol post-print reaction record with a deterministic evidence bar, and the options-implied move for comparison
- **Skills**: `pre-market`, `day-trade`, `overnight`, `earnings-bet`, `company-snapshot`, `x-research`
- **Channels**: interactive TUI, WhatsApp gateway with scheduled briefs (pre-market, open, midday, pre-close), event triggers, and a heartbeat that watches positions vs stops
- **Measurement**: nightly benchmark ledger and refusal counterfactual replay — the process is judged against the market, not against itself

Built on [virattt/dexter](https://github.com/virattt/dexter), the open-source financial research agent — the agent loop, TUI, and tool plumbing come from there; the trading mission, risk machinery, and IBKR integration are this fork's.

## ✅ Prerequisites

- [Bun](https://bun.com) runtime (v1.0 or higher)
- At least one LLM API key (OpenAI, Anthropic, Google, xAI, OpenRouter — or a local Ollama/vLLM)
- [IB Gateway](https://www.interactivebrokers.com/en/trading/ibgateway-stable.php) or TWS, logged into a **paper** account (port 4002 for IB Gateway paper, 7497 for TWS paper)
- A web-search key (Exa preferred; Perplexity/Tavily/LangSearch fallbacks) — catalysts must be verifiable
- Optional: Financial Datasets API key (present-state fundamentals; the system degrades gracefully without it)
- Optional, for backtests: FirstRate 1-minute OHLCV archives (`FIRSTRATE_DATA_DIR`) and GDELT sentiment parquets (`GDELT_DATA_DIR`) — proprietary data, not included

#### Installing Bun

**macOS/Linux:**
```bash
curl -fsSL https://bun.com/install | bash
```

**Windows:**
```bash
powershell -c "irm bun.sh/install.ps1|iex"
```

## 💻 How to Install

1. Clone the repository and install dependencies:
```bash
git clone https://github.com/virattt/dexter.git
cd dexter
bun install
```

2. Set up your environment:
```bash
cp env.example .env
# LLM provider (at least one):
#   OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY / XAI_API_KEY / OPENROUTER_API_KEY
# IBKR (paper first, always):
#   IBKR_HOST / IBKR_PORT=4002 / IBKR_CLIENT_ID
#   IBKR_MARKET_DATA_TYPE=3 for delayed data on unsubscribed paper accounts
#   IBKR_ALLOW_LIVE=false  ← order placement is refused on live ports/accounts otherwise
# Web search:
#   EXASEARCH_API_KEY (preferred) / PERPLEXITY_API_KEY / TAVILY_API_KEY / LANGSEARCH_API_KEY

# Verify the IBKR wiring end-to-end (read-only, never places orders):
bun run scripts/smoke-ibkr.ts AAPL
```

3. Review [src/config/risk-rules.yaml](src/config/risk-rules.yaml) — every number in it is a risk-appetite decision, and the gate enforces them without asking the LLM's opinion. The live profile ([risk-rules.live.yaml](src/config/risk-rules.live.yaml)) loads on top when a non-paper account is detected.

## 🚀 How to Run

Interactive TUI:
```bash
bun start
```

The full trading loop (schedules, triggers, WhatsApp, heartbeat):
```bash
bun run gateway
```

A trading day, hour by hour — and everything else operational — is in the [User Manual](docs/handbook/USER-MANUAL.md).

## 🧪 How to Test

```bash
bun run typecheck
bun test
```

The suite includes deterministic scenario tests for the trading machinery — the risk gate, the per-class position sizer (including worst-case-gap sizing for earnings bets), the pattern detectors, and the earnings-reaction math. Trade-decision *judgment* is not unit-tested; it is measured by the nightly benchmark ledger against what the market actually did.

## 🐛 How to Debug

Dexter logs all tool calls to a scratchpad file. Each query creates a new JSONL file in `.dexter/scratchpad/`:

```
.dexter/scratchpad/
├── 2026-01-30-111400_9a8f10723f79.jsonl
└── ...
```

Each file tracks the original query, every tool call with arguments and results, and the agent's reasoning steps:

```json
{"type":"tool_result","timestamp":"2026-08-05T15:31:05.123Z","toolName":"signal_scorer","args":{"ticker":"AMD"},"result":{...},"llmSummary":"AMD scores 82: momentum and volume aligned, extension 1.4× ATR — inside the chase gate"}
```

Gateway logs land in `.dexter/logs/` (JSONL, daily rotation).

## 📱 How to Use with WhatsApp

WhatsApp is the alert channel: briefs, trigger alerts, and trade proposals arrive there, and `accept P-XXXX` executes one (paper).

```bash
# Link your WhatsApp account (scan QR code)
bun run gateway:login

# Start the gateway
bun run gateway
```

For pairing details, the command reference, and troubleshooting, see the [WhatsApp Gateway README](src/gateway/channels/whatsapp/README.md) and [User Manual §8](docs/handbook/USER-MANUAL.md).

## 🛡️ Safety Model

- **Human-only execution**: the LLM creates proposals; only an explicit human accept (or the opt-in, paper-only auto-executor) places a bracket — entry, stop, and target transmitted atomically
- **Paper/live lock**: order placement is refused on live ports (4001/7496) or non-paper accounts unless `IBKR_ALLOW_LIVE=true`; the live risk profile trades fewer, smaller positions and keeps the earnings-bet class **disabled until it has a proven paper record**
- **Deterministic gates outrank the model**: risk/reward, noise-stop, extension, per-class budgets and caps, daily-loss guard, duplicate-setup guard, chase gate at acceptance — a refusal is information, not an obstacle
- **Kill-switch**: one command flattens and halts ([User Manual §10](docs/handbook/USER-MANUAL.md))
- **Honest ledger**: every outcome is recorded as it happened — stops, unlabeled exits, and refusals included — and replayed against the market nightly

## 🤝 How to Contribute

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

**Important**: Please keep your pull requests small and focused. This will make it easier to review and merge.

## 📄 License

This project is licensed under the MIT License.
