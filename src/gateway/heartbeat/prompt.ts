import { readFile } from 'node:fs/promises';
import { HEARTBEAT_OK_TOKEN } from './suppression.js';
import { dexterPath } from '../../utils/paths.js';

const HEARTBEAT_MD_PATH = dexterPath('HEARTBEAT.md');

const DEFAULT_CHECKLIST = `- Open positions vs their stops (ibkr_account, then ibkr_market_data per position): alert on anything trading within ~0.5× daily ATR of its stop, gapping past it, or left without a working stop order. Protection is verified with ibkr_orders (action list) — LIVE open orders only. NEVER infer protection from the proposals store: auto-protect GTC exits exist only at the broker (2026-08-07 false alarm: MGNI called naked while GTC stop/target were working)
- Proposal freshness (trade_proposals action list, status open): flag proposals whose entry the price has run away from or traded through, and any proposal that now holds through an earnings print (earnings_calendar action check) — suggest reject or re-propose
- Watchlist names (memory_search for the current watchlist) crossing their key levels or spiking volume between scheduled scans — verify with ibkr_market_data before alerting
- Market context, one line at most: SPY/QQQ moving more than 1.5% intraday or VIX spiking — context for the items above, never an alert on its own`;

/**
 * Load .dexter/HEARTBEAT.md content.
 * Returns the content string, or null if the file doesn't exist.
 */
export async function loadHeartbeatDocument(): Promise<string | null> {
  try {
    return await readFile(HEARTBEAT_MD_PATH, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Check if heartbeat content is effectively empty
 * (only headers, whitespace, or empty list items).
 */
export function isHeartbeatContentEmpty(content: string): boolean {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines, headers, and empty list items
    if (!trimmed) continue;
    if (/^#+\s*$/.test(trimmed)) continue;
    if (/^#+\s/.test(trimmed)) continue;
    if (/^[-*]\s*$/.test(trimmed)) continue;
    // Non-empty content found
    return false;
  }
  return true;
}

/**
 * Build the heartbeat query to send to the agent.
 * Returns null if the file exists but is empty (skip heartbeat).
 * Uses a default checklist if no file exists.
 */
export async function buildHeartbeatQuery(): Promise<string | null> {
  const content = await loadHeartbeatDocument();

  let checklist: string;
  if (content !== null) {
    if (isHeartbeatContentEmpty(content)) {
      return null; // File exists but is empty — skip heartbeat
    }
    checklist = content;
  } else {
    checklist = DEFAULT_CHECKLIST;
  }

  return `[HEARTBEAT CHECK]

You are running as a periodic heartbeat. Review the following checklist and check if anything noteworthy has happened that the user should know about.

## Checklist
${checklist}

## Instructions
- Use your tools to check each item on the checklist
- If you find something noteworthy, write a concise alert message for the user
- If nothing noteworthy is happening, respond with exactly: ${HEARTBEAT_OK_TOKEN}
- Do NOT send a message just to say "everything is fine" — only message if there's something actionable or noteworthy
- Keep alerts brief and focused — lead with the position or level affected and the action to take
- You may combine multiple findings into one message`;
}
