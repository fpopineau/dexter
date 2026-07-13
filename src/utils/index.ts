export { loadConfig, saveConfig, getSetting, setSetting } from './config.js';
export {
  getApiKeyNameForProvider,
  getProviderDisplayName,
  checkApiKeyExistsForProvider,
  saveApiKeyForProvider,
} from './env.js';
// NOTE: InMemoryChatHistory is deliberately NOT re-exported from this barrel.
// It imports model/llm → agent/prompts → tools/registry, which would drag the
// whole agent/tool graph (and an import cycle with the IBKR modules) into
// every consumer of '@/utils'. Import it from './in-memory-chat-history.js'.
export { logger } from './logger.js';
export type { LogEntry, LogLevel } from './logger.js';
export { extractTextContent, hasToolCalls } from './ai-message.js';
export { LongTermChatHistory } from './long-term-chat-history.js';
export type { ConversationEntry } from './long-term-chat-history.js';
export { findPrevWordStart, findNextWordEnd } from './text-navigation.js';
export { cursorHandlers } from './input-key-handlers.js';
export type { CursorContext } from './input-key-handlers.js';
export { getToolDescription } from './tool-description.js';
export { transformMarkdownTables, formatResponse } from './markdown-table.js';
export { estimateTokens } from './tokens.js';
export {
  parseApiErrorInfo,
  classifyError,
  isContextOverflowError,
  isNonRetryableError,
  formatUserFacingError,
} from './errors.js';