import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  id: string;
  level: LogLevel;
  message: string;
  timestamp: Date;
  data?: unknown;
}

type LogSubscriber = (logs: LogEntry[]) => void;

// ---------------------------------------------------------------------------
// File sink — JSONL, one file per day, best-effort and crash-proof.
//
// Controlled by environment variables (all optional):
//   DEXTER_LOG_DIR    directory for log files   (default: .dexter/logs)
//   DEXTER_LOG_LEVEL  minimum level persisted   (default: info; 'off' disables)
//   DEXTER_LOG_KEEP   daily files retained      (default: 14)
//
// The in-memory buffer feeding the TUI debug panel is unchanged and always
// captures every level.
// ---------------------------------------------------------------------------

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

class FileSink {
  private dir: string;
  private minRank: number | null; // null = disabled
  private keep: number;
  private currentDay = '';
  private currentPath = '';
  private failed = false;

  constructor() {
    this.dir = process.env.DEXTER_LOG_DIR || join('.dexter', 'logs');
    const lvl = (process.env.DEXTER_LOG_LEVEL || 'info').trim().toLowerCase();
    this.minRank = lvl === 'off' ? null : LEVEL_RANK[lvl as LogLevel] ?? LEVEL_RANK.info;
    const keep = Number(process.env.DEXTER_LOG_KEEP);
    this.keep = Number.isFinite(keep) && keep > 0 ? keep : 14;
  }

  write(entry: LogEntry): void {
    if (this.failed || this.minRank === null) return;
    if (LEVEL_RANK[entry.level] < this.minRank) return;
    try {
      const day = entry.timestamp.toISOString().slice(0, 10); // YYYY-MM-DD
      if (day !== this.currentDay) {
        this.rotate(day);
      }
      const line = JSON.stringify({
        ts: entry.timestamp.toISOString(),
        level: entry.level,
        msg: entry.message,
        ...(entry.data !== undefined ? { data: entry.data } : {}),
      });
      appendFileSync(this.currentPath, line + '\n');
    } catch {
      // Never let logging break the app: disable the sink after the first
      // hard failure (read-only FS, permission error, full disk, …).
      this.failed = true;
    }
  }

  private rotate(day: string): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    this.currentDay = day;
    this.currentPath = join(this.dir, `dexter-${day}.jsonl`);
    // Retention: prune oldest daily files beyond the keep window.
    try {
      const files = readdirSync(this.dir)
        .filter((f) => /^dexter-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort(); // lexicographic == chronological for this naming scheme
      for (const f of files.slice(0, Math.max(0, files.length - this.keep))) {
        unlinkSync(join(this.dir, f));
      }
    } catch { /* best-effort */ }
  }
}

class DebugLogger {
  private logs: LogEntry[] = [];
  private subscribers: Set<LogSubscriber> = new Set();
  private maxLogs = 50;
  private fileSink = new FileSink();

  private emit() {
    this.subscribers.forEach(fn => fn([...this.logs]));
  }

  private add(level: LogLevel, message: string, data?: unknown) {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      level,
      message,
      timestamp: new Date(),
      data,
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
    this.fileSink.write(entry);
    this.emit();
  }

  debug(message: string, data?: unknown) {
    this.add('debug', message, data);
  }

  info(message: string, data?: unknown) {
    this.add('info', message, data);
  }

  warn(message: string, data?: unknown) {
    this.add('warn', message, data);
  }

  error(message: string, data?: unknown) {
    this.add('error', message, data);
  }

  subscribe(fn: LogSubscriber): () => void {
    this.subscribers.add(fn);
    fn([...this.logs]); // Send current logs immediately
    return () => this.subscribers.delete(fn);
  }

  clear() {
    this.logs = [];
    this.emit();
  }
}

// Singleton instance
export const logger = new DebugLogger();
export type { LogEntry, LogLevel };
