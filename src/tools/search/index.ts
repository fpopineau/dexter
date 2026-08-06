/**
 * Rich description for the web_search tool.
 * Used in the system prompt to guide the LLM on when and how to use this tool.
 */
export const WEB_SEARCH_DESCRIPTION = `
Search the web for current information on any topic. Returns relevant search results with URLs and content snippets.

## When to Use

- Catalyst hunting on a named ticker: why is it moving, halt reason, guidance change, FDA/PDUFA, offering, analyst action, M&A chatter
- Current events, breaking news, recent developments
- Factual questions about entities (companies, people, organizations) where status can change
- Verifying claims about real-world state (public/private, active/defunct, current leadership)
- Technology updates, product announcements, industry trends

## When NOT to Use

- Historical stock prices for equities (use get_market_data)
- Structured financial data (company financials, SEC filings, key ratios - use get_financials instead)
- Pure conceptual/definitional questions ("What is RVOL?")

## Usage Notes

- Provide specific, well-formed search queries for best results
- Returns up to 5 results with URLs and content snippets
- Under time pressure, search for the specific catalyst ("XYZ halt reason", "XYZ guidance cut") — not the company name alone
`.trim();

export { tavilySearch } from './tavily.js';
export { exaSearch } from './exa.js';
export { perplexitySearch } from './perplexity.js';
export { langSearch } from './langsearch.js';
export { xSearchTool, X_SEARCH_DESCRIPTION } from './x-search.js';
