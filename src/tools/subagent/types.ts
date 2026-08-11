/**
 * Subagent type registry.
 *
 * A "subagent" is a fresh, isolated agent loop that the main (leader) agent can
 * delegate a focused sub-task to. Each type below is a small config bundle: a
 * worker system prompt, a tool allow-list, and an iteration budget. The leader
 * picks a type via the `spawn_subagent` tool; the subagent runs to completion
 * and returns a single answer.
 */

/** Configuration for one subagent type. */
export interface SubagentTypeConfig {
  /** Help text shown to the leader so it knows when to pick this type. */
  whenToUse: string;
  /** Self-contained worker system prompt for the subagent. */
  systemPrompt: string;
  /** Allow-list of tool names (must match registry names) the subagent may use. */
  tools: string[];
  /** Maximum agent loop iterations for the subagent. */
  maxIterations: number;
}

/**
 * Tools a subagent may never receive. The delegate tool is listed here so a
 * subagent can never spawn its own subagents — delegation is one level deep.
 */
export const SUBAGENT_DISALLOWED_TOOLS = new Set<string>(['spawn_subagent']);

/**
 * Read-only tools available to a general-purpose subagent. Deliberately excludes
 * write/edit/memory-mutation tools: subagents run in parallel and must not race
 * on approval prompts or side effects. Tool names not registered in the current
 * session (e.g. IBKR tools without a Gateway) are silently unavailable.
 */
const READ_ONLY_TOOLS = [
  'get_financials',
  'get_market_data',
  'read_filings',
  'stock_screener',
  'web_search',
  'x_search',
  'web_fetch',
  'read_file',
  'memory_search',
  'memory_get',
  'earnings_calendar',
  // Read-only: returns skill instructions (company-snapshot etc.) — the
  // 2026-08-11 brief's snapshot workers could not run the REQUIRED skill.
  'skill',
];

const WORKER_PREAMBLE =
  'You are a subagent working on a single sub-task assigned by an orchestrator. ' +
  'You run in isolation: you cannot see the main conversation and you cannot ' +
  'delegate to other subagents. Complete only the assigned task. Your final ' +
  'message is returned verbatim to the orchestrator, so make it a complete, ' +
  'self-contained answer — state your findings and conclusions directly, not a ' +
  'description of what you did.';

export const SUBAGENT_TYPES: Record<string, SubagentTypeConfig> = {
  'general-purpose': {
    whenToUse: 'Focused research or data-gathering that fits none of the trade-specific workers.',
    systemPrompt: `${WORKER_PREAMBLE}\n\nYou are a general-purpose worker for a trading agent. Use the available tools to gather and analyze whatever the task requires, then report your findings with the numbers that support them.`,
    tools: READ_ONLY_TOOLS,
    maxIterations: 8,
  },
  catalyst: {
    whenToUse: 'Catalyst check on one name: why is it moving, what is coming (news, prints, positioning).',
    systemPrompt: `${WORKER_PREAMBLE}\n\nYou are a catalyst-check worker. For the given symbol, establish: (1) WHY it is moving or expected to move — the specific story (guidance, halt, FDA, offering, analyst action, M&A), not "momentum"; (2) WHAT is scheduled ahead — earnings date and timing, known events inside the holding window; (3) WHO is positioned where — crowding and trapped-side risk when discernible. Cite sources with dates. Say plainly when you cannot verify a catalyst — an unverified story is a finding, not a gap to paper over.`,
    tools: ['web_search', 'x_search', 'web_fetch', 'read_filings', 'get_market_data', 'earnings_calendar', 'skill'],
    maxIterations: 8,
  },
  'setup-validation': {
    whenToUse: 'Validate one trade setup: structure, score, levels, data freshness.',
    systemPrompt: `${WORKER_PREAMBLE}\n\nYou are a setup-validation worker. For the given symbol and setup, verify with live data: (1) technical structure — trend, key levels, where the honest stop sits relative to ATR; (2) the signal score and each factor driving it; (3) data freshness — stale bars or disagreeing quotes make the setup unverifiable, and you must say so; (4) for earnings-bet candidates, the post-print record and evidence verdict (earnings_bet_intel). Report level-precise findings and a verdict on whether the setup holds up. You validate — you never propose or size trades.`,
    tools: ['technical_analysis', 'signal_scorer', 'ibkr_market_data', 'ibkr_historical', 'earnings_calendar', 'earnings_bet_intel', 'swing_patterns', 'risk_manager', 'skill'],
    maxIterations: 8,
  },
};

export const DEFAULT_SUBAGENT_TYPE = 'general-purpose';

/** The subagent types the leader may choose from. */
export const SUBAGENT_TYPE_NAMES = Object.keys(SUBAGENT_TYPES) as [string, ...string[]];

/** Resolve a type's tool allow-list with disallowed tools stripped defensively. */
export function resolveSubagentTools(typeKey: string): string[] {
  const cfg = SUBAGENT_TYPES[typeKey] ?? SUBAGENT_TYPES[DEFAULT_SUBAGENT_TYPE];
  return cfg.tools.filter(t => !SUBAGENT_DISALLOWED_TOOLS.has(t));
}
