/**
 * Core fetch / redirect / convert / cache / summarize pipeline for web_fetch.
 *
 * Fetches a URL with strict manual redirect handling, converts HTML to
 * markdown, persists binary downloads to disk, caches results, and applies a
 * user prompt to the content using a small, fast model.
 */
import axios, { type AxiosResponse } from 'axios';
import { LRUCache } from 'lru-cache';
import { callLlm, getFastModel } from '../../model/llm.js';
import { resolveProvider } from '../../providers.js';
import { logger } from '../../utils/index.js';
import { isBinaryContentType, persistBinaryContent } from './binary-storage.js';
import { makeSecondaryModelPrompt } from './prompt.js';

// Raised when an outbound request is blocked by a network egress proxy.
class EgressBlockedError extends Error {
  constructor(public readonly domain: string) {
    super(`Access to ${domain} is blocked by the network egress proxy.`);
    this.name = 'EgressBlockedError';
  }
}

// Cache entry for fetched URL content.
type CacheEntry = {
  bytes: number;
  code: number;
  codeText: string;
  content: string;
  contentType: string;
  persistedPath?: string;
  persistedSize?: number;
};

// URL content cache: 15-minute TTL, 50MB size cap. LRUCache handles
// expiration and eviction automatically.
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

const URL_CACHE = new LRUCache<string, CacheEntry>({
  maxSize: MAX_CACHE_SIZE_BYTES,
  ttl: CACHE_TTL_MS,
});

export function clearWebFetchCache(): void {
  URL_CACHE.clear();
}

// Lazy singleton TurndownService. Defers the turndown import until the first
// HTML fetch and reuses one instance across calls (construction is the
// expensive part; .turndown() is stateless).
type TurndownCtor = typeof import('turndown');
let turndownServicePromise: Promise<InstanceType<TurndownCtor>> | undefined;
function getTurndownService(): Promise<InstanceType<TurndownCtor>> {
  return (turndownServicePromise ??= import('turndown').then((m) => {
    const Turndown = (m as unknown as { default: TurndownCtor }).default;
    return new Turndown();
  }));
}

// Allow long signed URLs (e.g. JWT-signed cloud storage links).
const MAX_URL_LENGTH = 2000;

// Cap the size of an HTTP response body (10MB).
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024;

// Timeout for the main HTTP fetch (60 seconds).
const FETCH_TIMEOUT_MS = 60_000;

// Cap same-host redirect hops to avoid redirect loops resetting the timeout.
const MAX_REDIRECTS = 10;

// Truncate content handed to the secondary model to bound token usage.
export const MAX_MARKDOWN_LENGTH = 100_000;

/**
 * Identifying User-Agent so site operators can recognize and rate-limit this
 * client distinctly from browser traffic.
 */
export function getWebFetchUserAgent(): string {
  return 'Dexter-User (dexter-ts; +https://github.com/)';
}

/**
 * True when the hostname is an IP literal inside a private, loopback,
 * link-local, or otherwise reserved range — SSRF targets, never legitimate
 * research fetches. (DNS names resolving to private space are a residual
 * risk; the agent runs on the operator's own machine, so the primary threat
 * is prompt-injected fetches of well-known local endpoints.)
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase(); // strip IPv6 brackets

  // IPv6 literals: loopback, unspecified, link-local, unique-local, v4-mapped.
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (/^fe[89ab]/.test(host) || /^f[cd]/.test(host)) return true;
    if (host.startsWith('::ffff:')) {
      // v4-mapped — URL parsers emit either ::ffff:1.2.3.4 or ::ffff:0102:0304.
      const rest = host.slice(7);
      if (rest.includes('.')) return isPrivateOrReservedHost(rest);
      const groups = rest.split(':');
      if (groups.length === 2) {
        const hi = parseInt(groups[0], 16), lo = parseInt(groups[1], 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          return isPrivateOrReservedHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
        }
      }
      return true; // malformed mapped form — refuse
    }
    return false;
  }

  // IPv4 literal?
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) {
    // Named hosts: block the conventional local ones.
    return host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal';
  }
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 10 || a === 127) return true;                 // this-net, private, loopback
  if (a === 169 && b === 254) return true;                            // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;                   // private
  if (a === 192 && b === 168) return true;                            // private
  if (a === 100 && b >= 64 && b <= 127) return true;                  // CGNAT
  if (a >= 224) return true;                                          // multicast/reserved
  return false;
}

export function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Only web protocols — file:, ftp:, chrome:, etc. are never fetchable.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  // Block URLs carrying credentials.
  if (parsed.username || parsed.password) {
    return false;
  }

  // Block private/reserved targets (SSRF: IB Gateway API, local services).
  if (isPrivateOrReservedHost(parsed.hostname)) {
    return false;
  }

  // Require a publicly-shaped hostname (at least two labels), filtering out
  // internal/single-label hosts like "localhost".
  const parts = parsed.hostname.split('.');
  if (parts.length < 2 && !parsed.hostname.includes(':')) {
    return false;
  }

  return true;
}

/**
 * Decide whether a redirect is safe to follow automatically. Allows redirects
 * that keep the same origin (protocol + port + host), permitting only the
 * addition or removal of a leading "www." and changes to path/query. Anything
 * that crosses to a different host is reported back to the caller instead.
 */
export function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
  try {
    const parsedOriginal = new URL(originalUrl);
    const parsedRedirect = new URL(redirectUrl);

    if (parsedRedirect.protocol !== parsedOriginal.protocol) {
      return false;
    }
    if (parsedRedirect.port !== parsedOriginal.port) {
      return false;
    }
    if (parsedRedirect.username || parsedRedirect.password) {
      return false;
    }

    const stripWww = (hostname: string) => hostname.replace(/^www\./, '');
    return stripWww(parsedOriginal.hostname) === stripWww(parsedRedirect.hostname);
  } catch {
    return false;
  }
}

export type RedirectInfo = {
  type: 'redirect';
  originalUrl: string;
  redirectUrl: string;
  statusCode: number;
};

/**
 * Fetch a URL while controlling redirects manually. Same-origin redirects that
 * pass `redirectChecker` are followed (up to MAX_REDIRECTS hops); cross-host
 * redirects are returned as RedirectInfo so the caller can surface them.
 */
export async function getWithPermittedRedirects(
  url: string,
  signal: AbortSignal,
  redirectChecker: (originalUrl: string, redirectUrl: string) => boolean,
  depth = 0,
): Promise<AxiosResponse<ArrayBuffer> | RedirectInfo> {
  if (depth > MAX_REDIRECTS) {
    throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`);
  }
  try {
    return await axios.get<ArrayBuffer>(url, {
      signal,
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 0,
      responseType: 'arraybuffer',
      maxContentLength: MAX_HTTP_CONTENT_LENGTH,
      headers: {
        Accept: 'text/markdown, text/html, */*',
        'User-Agent': getWebFetchUserAgent(),
      },
    });
  } catch (error) {
    if (
      axios.isAxiosError(error) &&
      error.response &&
      [301, 302, 307, 308].includes(error.response.status)
    ) {
      const redirectLocation = error.response.headers.location;
      if (!redirectLocation) {
        throw new Error('Redirect missing Location header');
      }

      // Resolve relative redirects against the current URL.
      const redirectUrl = new URL(redirectLocation, url).toString();

      if (redirectChecker(url, redirectUrl)) {
        return getWithPermittedRedirects(redirectUrl, signal, redirectChecker, depth + 1);
      }
      return {
        type: 'redirect',
        originalUrl: url,
        redirectUrl,
        statusCode: error.response.status,
      };
    }

    // Detect egress proxy blocks (403 + X-Proxy-Error: blocked-by-allowlist).
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 403 &&
      error.response.headers['x-proxy-error'] === 'blocked-by-allowlist'
    ) {
      throw new EgressBlockedError(new URL(url).hostname);
    }

    throw error;
  }
}

function isRedirectInfo(
  response: AxiosResponse<ArrayBuffer> | RedirectInfo,
): response is RedirectInfo {
  return 'type' in response && response.type === 'redirect';
}

export type FetchedContent = {
  content: string;
  bytes: number;
  code: number;
  codeText: string;
  contentType: string;
  persistedPath?: string;
  persistedSize?: number;
};

/**
 * Fetch a URL and return its content as markdown (HTML is converted via
 * Turndown), or a RedirectInfo if it redirects to a different host.
 */
export async function getURLMarkdownContent(
  url: string,
  abortController: AbortController,
): Promise<FetchedContent | RedirectInfo> {
  if (!validateURL(url)) {
    throw new Error('Invalid URL');
  }

  // Serve from cache when available (TTL handled by LRUCache).
  const cachedEntry = URL_CACHE.get(url);
  if (cachedEntry) {
    return {
      bytes: cachedEntry.bytes,
      code: cachedEntry.code,
      codeText: cachedEntry.codeText,
      content: cachedEntry.content,
      contentType: cachedEntry.contentType,
      persistedPath: cachedEntry.persistedPath,
      persistedSize: cachedEntry.persistedSize,
    };
  }

  // Upgrade http to https.
  let upgradedUrl = url;
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol === 'http:') {
      parsedUrl.protocol = 'https:';
      upgradedUrl = parsedUrl.toString();
    }
  } catch (e) {
    logger.error(`[web_fetch] URL parse error: ${e instanceof Error ? e.message : String(e)}`);
  }

  const response = await getWithPermittedRedirects(
    upgradedUrl,
    abortController.signal,
    isPermittedRedirect,
  );

  if (isRedirectInfo(response)) {
    return response;
  }

  const rawBuffer = Buffer.from(response.data);
  // Release the axios-held copy so GC can reclaim it before Turndown builds
  // its DOM tree.
  (response as { data: unknown }).data = null;
  const contentType = String(response.headers['content-type'] ?? '');

  // Persist binary downloads (PDFs, etc.) to disk. The decoded text is still
  // summarized below — for PDFs the decoded string retains enough ASCII
  // structure to summarize, and the saved file is a supplement.
  let persistedPath: string | undefined;
  let persistedSize: number | undefined;
  if (isBinaryContentType(contentType)) {
    const persistId = `webfetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = persistBinaryContent(rawBuffer, contentType, persistId);
    if (!('error' in result)) {
      persistedPath = result.filepath;
      persistedSize = result.size;
    }
  }

  const bytes = rawBuffer.length;
  const htmlContent = rawBuffer.toString('utf-8');

  let markdownContent: string;
  let contentBytes: number;
  if (contentType.includes('text/html')) {
    markdownContent = (await getTurndownService()).turndown(htmlContent);
    contentBytes = Buffer.byteLength(markdownContent);
  } else {
    // Non-HTML: use the decoded text as-is. Its UTF-8 byte length equals the
    // raw buffer length, so reuse `bytes` for cache accounting.
    markdownContent = htmlContent;
    contentBytes = bytes;
  }

  // Cache under the original URL (not the upgraded/redirected one).
  const entry: CacheEntry = {
    bytes,
    code: response.status,
    codeText: response.statusText,
    content: markdownContent,
    contentType,
    persistedPath,
    persistedSize,
  };
  // lru-cache requires a positive size; clamp to 1 for empty responses.
  URL_CACHE.set(url, entry, { size: Math.max(1, contentBytes) });
  return entry;
}

/**
 * Apply the user's prompt to fetched markdown content using a small, fast
 * model. The content is truncated to MAX_MARKDOWN_LENGTH to avoid overflowing
 * the secondary model's context.
 */
export async function applyPromptToMarkdown(
  prompt: string,
  markdownContent: string,
  signal: AbortSignal,
  model: string,
): Promise<string> {
  const truncatedContent =
    markdownContent.length > MAX_MARKDOWN_LENGTH
      ? markdownContent.slice(0, MAX_MARKDOWN_LENGTH) + '\n\n[Content truncated due to length...]'
      : markdownContent;

  const fastModel = getFastModel(resolveProvider(model).id, model);
  const userPrompt = makeSecondaryModelPrompt(truncatedContent, prompt);

  const { response } = await callLlm(userPrompt, {
    model: fastModel,
    systemPrompt:
      'You are a web content extraction assistant. Answer the request using only the provided web page content.',
    signal,
  });

  if (signal.aborted) {
    throw new Error('Web fetch aborted');
  }

  if (typeof response === 'string') {
    return response;
  }
  const content = (response as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content;
  }
  return 'No response from model';
}
