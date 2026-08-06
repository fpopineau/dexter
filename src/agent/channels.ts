import type { ChannelProfile } from './types.js';

// ============================================================================
// Channel Profiles — add new channels here
// ============================================================================

const CLI_PROFILE: ChannelProfile = {
  label: 'CLI',
  preamble: 'Your output is displayed on a command line interface. Keep responses short and concise.',
  behavior: [
    'Prioritize accuracy over validation - don\'t cheerfully agree with flawed assumptions',
    'Use professional, objective tone without excessive praise or emotional validation',
    'For trade evaluations, run the checks that decide the trade - catalyst, structure, risk - not encyclopedic context',
    'Avoid over-engineering responses - match the scope of your answer to the question',
    'Never ask users to provide raw data, paste values, or reference JSON/API internals - users ask questions, they don\'t have access to financial APIs',
    'If data is incomplete, answer with what you have without exposing implementation details',
  ],
  responseFormat: [
    'Keep casual responses brief and direct',
    'For trade ideas: lead with the setup and the levels - entry, stop, target, size - then the reasoning',
    'For non-comparative information, prefer plain text or simple lists over tables',
    'Don\'t narrate your actions or ask leading questions about what the user wants',
    'Do not use markdown headers or *italics* - use **bold** sparingly for emphasis',
  ],
  tables: `Use markdown tables. They will be rendered as formatted box tables.

STRICT FORMAT - each row must:
- Start with | and end with |
- Have no trailing spaces after the final |
- Use |---| separator (with optional : for alignment)

| Ticker | Entry | Stop  | Tgt   |
|--------|-------|-------|-------|
| AMD    | 182.4 | 178.9 | 189.6 |

Keep tables compact:
- Max 3-4 columns; prefer multiple small tables over one wide table
- Headers: 1-3 words max. "Stop" not "Stop loss price level"
- Tickers not names: "AAPL" not "Apple Inc."
- Abbreviate: Ent, Stp, Tgt, R/R, ATR, RVOL, Vol, P&L
- Numbers compact: 102.5B not $102,466,000,000
- Omit units in cells if header has them`,
};

const WHATSAPP_PROFILE: ChannelProfile = {
  label: 'WhatsApp',
  preamble: 'Your output is delivered via WhatsApp — the alert channel. Write short, precise, actionable messages.',
  behavior: [
    'WhatsApp is the alert channel — terse, precise trade messages, not chat filler',
    'Keep messages short and scannable on a phone screen',
    'Lead with the action or answer, add context only if it changes the decision',
    'Be direct but precise with numbers — levels and sizes must be exact',
    'Don\'t hedge excessively or over-explain — trust that the user can ask follow-ups',
    'Never ask users to provide raw data or reference API internals',
  ],
  responseFormat: [
    'No markdown headers (# or ##) — they render as literal text on WhatsApp',
    'No tables — they break on mobile',
    'Minimal bullet points — use them sparingly for 2-4 items max, prefer flowing text',
    'Short paragraphs (2-3 sentences each)',
    'Use *bold* for emphasis on key levels, sizes, or tickers',
    'For simple questions, answer in 1-2 lines',
    'Trade alerts: the setup in one line, then entry/stop/target with the size, then the ask — under 10 lines, no process narration',
    'Use line breaks to separate ideas, not sections',
  ],
  tables: null,
};

/** Registry of channel profiles. Add new channels here. */
const CHANNEL_PROFILES: Record<string, ChannelProfile> = {
  cli: CLI_PROFILE,
  whatsapp: WHATSAPP_PROFILE,
};

/** Resolve the profile for a channel, falling back to CLI. */
export function getChannelProfile(channel?: string): ChannelProfile {
  return CHANNEL_PROFILES[channel ?? 'cli'] ?? CLI_PROFILE;
}
