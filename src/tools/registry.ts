import { StructuredToolInterface } from '@langchain/core/tools';
import { discoverSkills } from '../skills/index.js';
import { getSetting } from '../utils/config.js';
import type { SearchProviderId } from '../utils/env.js';
import { BROWSER_DESCRIPTION, browserTool } from './browser/browser.js';
import { CRON_TOOL_DESCRIPTION, cronTool } from './cron/cron-tool.js';
import { createWebFetch, WEB_FETCH_DESCRIPTION } from './fetch/web-fetch.js';
import { EDIT_FILE_DESCRIPTION, editFileTool } from './filesystem/edit-file.js';
import { READ_FILE_DESCRIPTION, readFileTool } from './filesystem/read-file.js';
import { WRITE_FILE_DESCRIPTION, writeFileTool } from './filesystem/write-file.js';
import { GET_FINANCIALS_DESCRIPTION } from './finance/get-financials.js';
import { GET_MARKET_DATA_DESCRIPTION } from './finance/get-market-data.js';
import { createGetFinancials, createGetMarketData, createReadFilings, createScreenStocks } from './finance/index.js';
import { READ_FILINGS_DESCRIPTION } from './finance/read-filings.js';
import { SCREEN_STOCKS_DESCRIPTION } from './finance/screen-stocks.js';
import { HEARTBEAT_TOOL_DESCRIPTION, heartbeatTool } from './heartbeat/heartbeat-tool.js';
import { createIbkrAccount, createIbkrHistorical, createIbkrMarketData, createIbkrOrders, createIbkrScanner, createRiskManager, createSignalScorer, createTechnicalAnalysis, IBKR_ACCOUNT_DESCRIPTION, IBKR_HISTORICAL_DESCRIPTION, IBKR_MARKET_DATA_DESCRIPTION, IBKR_ORDERS_DESCRIPTION, IBKR_SCANNER_DESCRIPTION, RISK_MANAGER_DESCRIPTION, SIGNAL_SCORER_DESCRIPTION, TECHNICAL_ANALYSIS_DESCRIPTION } from './ibkr/index.js';
import { MEMORY_GET_DESCRIPTION, MEMORY_SEARCH_DESCRIPTION, MEMORY_UPDATE_DESCRIPTION, memoryGetTool, memorySearchTool, memoryUpdateTool } from './memory/index.js';
import { createOpportunitiesTool, OPPORTUNITIES_DESCRIPTION } from './opportunities/index.js';
import { createEarningsCalendarTool, EARNINGS_CALENDAR_DESCRIPTION } from './earnings/index.js';
import { createEventRiskTool, EVENT_RISK_DESCRIPTION } from './events/index.js';
import { createNewsPulseTool, NEWS_PULSE_DESCRIPTION } from './news/index.js';
import { createEarningsBetIntelTool, EARNINGS_BET_INTEL_DESCRIPTION } from './earnings/bet-intel.js';
import { createSwingPatternsTool, SWING_PATTERNS_DESCRIPTION } from './patterns/index.js';
import { ACCEPT_PROPOSAL_DESCRIPTION, createAcceptProposalTool, createTradeProposalsTool, TRADE_PROPOSALS_DESCRIPTION } from './proposals/index.js';
import { exaSearch, langSearch, perplexitySearch, tavilySearch, WEB_SEARCH_DESCRIPTION, X_SEARCH_DESCRIPTION, xSearchTool } from './search/index.js';
import { createWebSearchTool, type WebSearchProvider } from './search/web-search.js';
import { SKILL_TOOL_DESCRIPTION, skillTool } from './skill.js';
import { createSpawnSubagent, SPAWN_SUBAGENT_DESCRIPTION } from './subagent/spawn-subagent.js';

/**
 * A registered tool with its rich description for system prompt injection.
 */
export interface RegisteredTool {
  /** Tool name (must match the tool's name property) */
  name: string;
  /** The actual tool instance */
  tool: StructuredToolInterface;
  /** Rich description for system prompt (includes when to use, when not to use, etc.) */
  description: string;
  /** 1-2 sentence description for token-optimized system prompts. */
  compactDescription: string;
  /** Whether this tool can safely execute concurrently with other concurrent-safe tools. */
  concurrencySafe: boolean;
}

/**
 * Get all registered tools with their descriptions.
 * Conditionally includes tools based on environment configuration.
 *
 * @param model - The model name (needed for tools that require model-specific configuration)
 * @returns Array of registered tools
 */
export function getToolRegistry(model: string): RegisteredTool[] {
  const tools: RegisteredTool[] = [
    {
      name: 'get_financials',
      tool: createGetFinancials(model),
      description: GET_FINANCIALS_DESCRIPTION,
      compactDescription: 'Financial statements and metrics. Handles multi-company/multi-metric queries in one call.',
      concurrencySafe: true,
    },
    {
      name: 'get_market_data',
      tool: createGetMarketData(model),
      description: GET_MARKET_DATA_DESCRIPTION,
      compactDescription: 'Stock/crypto prices, company news, and insider trades. Handles multi-asset queries in one call.',
      concurrencySafe: true,
    },
    {
      name: 'read_filings',
      tool: createReadFilings(model),
      description: READ_FILINGS_DESCRIPTION,
      compactDescription: 'SEC filings (10-K, 10-Q, 8-K). Extracts and summarizes specific filing sections.',
      concurrencySafe: true,
    },
    {
      name: 'stock_screener',
      tool: createScreenStocks(model),
      description: SCREEN_STOCKS_DESCRIPTION,
      compactDescription: 'Screen stocks by present-state financial criteria — context filters, not the trade funnel.',
      concurrencySafe: true,
    },
    {
      name: 'spawn_subagent',
      tool: createSpawnSubagent(model),
      description: SPAWN_SUBAGENT_DESCRIPTION,
      compactDescription: 'Delegate a focused sub-task to an isolated subagent. Emit multiple calls in one turn to run independent sub-tasks in parallel.',
      concurrencySafe: true,
    },
    {
      name: 'web_fetch',
      tool: createWebFetch(model),
      description: WEB_FETCH_DESCRIPTION,
      compactDescription: 'Fetch a URL and answer a prompt about its content (HTML→markdown, fast-model summarized).',
      concurrencySafe: true,
    },
    {
      name: 'browser',
      tool: browserTool,
      description: BROWSER_DESCRIPTION,
      compactDescription: 'JavaScript-rendered pages and interactive navigation. Actions: navigate, snapshot, act, read, close.',
      // Singleton page/refs state — parallel calls would act on the wrong tab.
      concurrencySafe: false,
    },
    {
      name: 'read_file',
      tool: readFileTool,
      description: READ_FILE_DESCRIPTION,
      compactDescription: 'Read a local file by path. Returns file content as text.',
      concurrencySafe: true,
    },
    {
      name: 'write_file',
      tool: writeFileTool,
      description: WRITE_FILE_DESCRIPTION,
      compactDescription: 'Create or overwrite a file. Requires user approval.',
      concurrencySafe: false,
    },
    {
      name: 'edit_file',
      tool: editFileTool,
      description: EDIT_FILE_DESCRIPTION,
      compactDescription: 'Edit a file by replacing text. Requires user approval.',
      concurrencySafe: false,
    },
    {
      name: 'heartbeat',
      tool: heartbeatTool,
      description: HEARTBEAT_TOOL_DESCRIPTION,
      compactDescription: 'View or update the periodic heartbeat checklist (.dexter/HEARTBEAT.md).',
      concurrencySafe: true,
    },
    {
      name: 'cron',
      tool: cronTool,
      description: CRON_TOOL_DESCRIPTION,
      compactDescription: 'Manage scheduled cron jobs (create, list, update, delete).',
      concurrencySafe: true,
    },
    {
      name: 'memory_search',
      tool: memorySearchTool,
      description: MEMORY_SEARCH_DESCRIPTION,
      compactDescription: 'Search persistent memory and past conversations for stored facts and preferences.',
      concurrencySafe: true,
    },
    {
      name: 'memory_get',
      tool: memoryGetTool,
      description: MEMORY_GET_DESCRIPTION,
      compactDescription: 'Read specific memory file sections by line range.',
      concurrencySafe: true,
    },
    {
      name: 'memory_update',
      tool: memoryUpdateTool,
      description: MEMORY_UPDATE_DESCRIPTION,
      compactDescription: 'Add, edit, or delete persistent memory entries.',
      concurrencySafe: false,
    },
    {
      name: 'event_risk',
      tool: createEventRiskTool(),
      description: EVENT_RISK_DESCRIPTION,
      compactDescription: 'Dated macro binaries (CPI/FOMC/jobs) with market-implied probabilities; per-symbol Polymarket earnings markets (external signal for earnings bets).',
      concurrencySafe: true,
    },
    {
      name: 'news_pulse',
      tool: createNewsPulseTool(),
      description: NEWS_PULSE_DESCRIPTION,
      compactDescription: 'News breadth (GDELT sweep) for book + reactors + candidates: headline counts, domains, hot flags. Confirmation, not a scoring input.',
      concurrencySafe: true,
    },
  ];

  // Include IBKR tools if IBKR_HOST or IBKR_PORT is configured
  if (process.env.IBKR_HOST || process.env.IBKR_PORT) {
    tools.push(
      {
        name: 'ibkr_market_data',
        tool: createIbkrMarketData(),
        description: IBKR_MARKET_DATA_DESCRIPTION,
        compactDescription: 'Real-time market data snapshot from Interactive Brokers (bid, ask, last, OHLC, volume).',
        concurrencySafe: true,
      },
      {
        name: 'ibkr_historical',
        tool: createIbkrHistorical(),
        description: IBKR_HISTORICAL_DESCRIPTION,
        compactDescription: 'Historical OHLCV bars from Interactive Brokers (1s to 1M bars, flexible duration).',
        concurrencySafe: true,
      },
      {
        name: 'technical_analysis',
        tool: createTechnicalAnalysis(),
        description: TECHNICAL_ANALYSIS_DESCRIPTION,
        compactDescription: 'Compute TA indicators (RSI, MACD, Bollinger, ATR, VWAP, EMAs, volume) for a ticker from live IBKR data.',
        concurrencySafe: true,
      },
      {
        name: 'signal_scorer',
        tool: createSignalScorer(),
        description: SIGNAL_SCORER_DESCRIPTION,
        compactDescription: 'Multi-factor signal score (0–100) for a trade candidate. Evaluates momentum, mean-reversion, volume, and trend alignment.',
        concurrencySafe: true,
      },
      {
        name: 'risk_manager',
        tool: createRiskManager(),
        description: RISK_MANAGER_DESCRIPTION,
        compactDescription: 'Validate a trade against risk rules (position size, R/R, stops, overnight limits). Returns PASS/FAIL.',
        concurrencySafe: true,
      },
      {
        name: 'ibkr_scanner',
        tool: createIbkrScanner(),
        description: IBKR_SCANNER_DESCRIPTION,
        compactDescription: 'IBKR market scanner: top gainers, losers, most active, gappers, unusual volume. Returns ranked results.',
        concurrencySafe: true,
      },
      {
        name: 'ibkr_orders',
        tool: createIbkrOrders(),
        description: IBKR_ORDERS_DESCRIPTION,
        compactDescription: 'REDUCE-ONLY order management through IBKR: close/trim existing positions, cancel, list. New exposure goes through trade_proposals.',
        concurrencySafe: false,
      },
      {
        name: 'ibkr_account',
        tool: createIbkrAccount(),
        description: IBKR_ACCOUNT_DESCRIPTION,
        compactDescription: 'Query IBKR account: balances, margin, positions, daily P&L.',
        concurrencySafe: true,
      },
      {
        name: 'opportunities',
        tool: createOpportunitiesTool(),
        description: OPPORTUNITIES_DESCRIPTION,
        compactDescription: 'Ranked trading opportunities from the continuous market scanner (latest snapshot or fresh cycle). Advisory only.',
        concurrencySafe: false,
      },
      {
        name: 'earnings_calendar',
        tool: createEarningsCalendarTool(),
        description: EARNINGS_CALENDAR_DESCRIPTION,
        compactDescription: 'US earnings calendar (free): who reports on a date; whether given symbols report within N trading days (weekends/holidays skipped).',
        concurrencySafe: true,
      },
      {
        name: 'swing_patterns',
        tool: createSwingPatternsTool(),
        description: SWING_PATTERNS_DESCRIPTION,
        compactDescription: 'Nightly swing-pattern scan (pullback, flat-base, cup-and-handle) over the midcap universe daily history.',
        concurrencySafe: true,
      },
      {
        name: 'earnings_bet_intel',
        tool: createEarningsBetIntelTool(),
        description: EARNINGS_BET_INTEL_DESCRIPTION,
        compactDescription: 'Earnings-bet evidence: the symbol\'s post-print reaction record (evidence verdict, worst adverse gap) and the options-implied move.',
        concurrencySafe: true,
      },
      {
        name: 'trade_proposals',
        tool: createTradeProposalsTool(),
        description: TRADE_PROPOSALS_DESCRIPTION,
        compactDescription: 'Create, list, get, or reject persisted trade proposals. Creating never trades; execution is human-only.',
        concurrencySafe: false,
      },
      {
        name: 'accept_proposal',
        tool: createAcceptProposalTool(),
        description: ACCEPT_PROPOSAL_DESCRIPTION,
        compactDescription: 'Execute an open trade proposal as a paper bracket order. Requires interactive approval; kill-switch enforced.',
        concurrencySafe: false,
      },
    );
  }

  // Build web_search as a fallback chain over whichever providers have keys configured.
  // The user's preferred provider (set via /search) is tried first; the others act as fallbacks.
  const allWebSearchProviders: WebSearchProvider[] = [];
  if (process.env.EXASEARCH_API_KEY) {
    allWebSearchProviders.push({ id: 'exa', name: 'Exa', tool: exaSearch });
  }
  if (process.env.PERPLEXITY_API_KEY) {
    allWebSearchProviders.push({ id: 'perplexity', name: 'Perplexity', tool: perplexitySearch });
  }
  if (process.env.TAVILY_API_KEY) {
    allWebSearchProviders.push({ id: 'tavily', name: 'Tavily', tool: tavilySearch });
  }
  if (process.env.LANGSEARCH_API_KEY) {
    allWebSearchProviders.push({ id: 'langsearch', name: 'LangSearch', tool: langSearch });
  }

  if (allWebSearchProviders.length > 0) {
    const preferred = getSetting<SearchProviderId | undefined>('webSearchPreferredProvider', undefined);
    const orderedProviders = preferred
      ? [
          ...allWebSearchProviders.filter((p) => p.id === preferred),
          ...allWebSearchProviders.filter((p) => p.id !== preferred),
        ]
      : allWebSearchProviders;

    tools.push({
      name: 'web_search',
      tool: createWebSearchTool(orderedProviders),
      description: WEB_SEARCH_DESCRIPTION,
      compactDescription: 'Search the web for current information. Returns titles, URLs, and snippets.',
      concurrencySafe: true,
    });
  }

  if (process.env.X_BEARER_TOKEN) {
    tools.push({
      name: 'x_search',
      tool: xSearchTool,
      description: X_SEARCH_DESCRIPTION,
      compactDescription: 'Search X/Twitter for tweets, profiles, and threads.',
      concurrencySafe: true,
    });
  }

  const availableSkills = discoverSkills();
  if (availableSkills.length > 0) {
    tools.push({
      name: 'skill',
      tool: skillTool,
      description: SKILL_TOOL_DESCRIPTION,
      compactDescription: 'Invoke a specialized skill workflow (e.g., day-trade scan, overnight review).',
      concurrencySafe: false,
    });
  }

  return tools;
}

/**
 * Build a name → concurrencySafe map for the tool executor.
 */
export function getToolConcurrencyMap(model: string): Map<string, boolean> {
  return new Map(getToolRegistry(model).map(t => [t.name, t.concurrencySafe]));
}

/**
 * Get just the tool instances for binding to the LLM.
 *
 * @param model - The model name
 * @returns Array of tool instances
 */
export function getTools(model: string): StructuredToolInterface[] {
  return getToolRegistry(model).map((t) => t.tool);
}

/**
 * Build the tool descriptions section for the system prompt.
 * Formats each tool's rich description with a header.
 *
 * @param model - The model name
 * @returns Formatted string with all tool descriptions
 */
/**
 * Build compact tool descriptions for token-optimized system prompts.
 * Uses 1-2 sentence descriptions instead of full multi-paragraph ones.
 * The LLM already has full tool schemas via bindTools().
 */
export function buildCompactToolDescriptions(model: string): string {
  return getToolRegistry(model)
    .map((t) => `- **${t.name}**: ${t.compactDescription}`)
    .join('\n');
}
