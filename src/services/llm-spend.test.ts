import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    addUsage,
    assertSpendConfig,
    cronReserveUsd,
    dailySpendCapUsd,
    isCronLane,
    isEvaluationLane,
    priceUsd,
    readSpendLedger,
    readSpendPrices,
    recordLlmUsage,
    rollLedger,
    spendVerdict,
    writeSpendLedger,
} from './llm-spend.js';

const PRICES = { inUsdPerMtok: 3, outUsdPerMtok: 15 };

describe('LLM spend meter (REQ-LLM-001)', () => {
    test('priceUsd bills input and output tokens at the configured per-million prices', () => {
        expect(priceUsd({ inputTokens: 1_000_000, outputTokens: 0 }, PRICES)).toBe(3);
        expect(priceUsd({ inputTokens: 0, outputTokens: 1_000_000 }, PRICES)).toBe(15);
        expect(priceUsd({ inputTokens: 200_000, outputTokens: 10_000 }, PRICES)).toBeCloseTo(0.6 + 0.15, 6);
        expect(priceUsd({ inputTokens: 0, outputTokens: 0 }, PRICES)).toBe(0);
    });

    test('readSpendPrices needs BOTH knobs as positive numbers; otherwise null', () => {
        expect(readSpendPrices({ LLM_PRICE_IN_USD_PER_MTOK: '3', LLM_PRICE_OUT_USD_PER_MTOK: '15' })).toEqual(PRICES);
        expect(readSpendPrices({ LLM_PRICE_IN_USD_PER_MTOK: '3' })).toBeNull();
        expect(readSpendPrices({ LLM_PRICE_IN_USD_PER_MTOK: 'free', LLM_PRICE_OUT_USD_PER_MTOK: '15' })).toBeNull();
        expect(readSpendPrices({})).toBeNull();
    });

    test('dailySpendCapUsd defaults to 10; 0 disables; garbage → default', () => {
        expect(dailySpendCapUsd({})).toBe(10);
        expect(dailySpendCapUsd({ LLM_DAILY_SPEND_CAP_USD: '25' })).toBe(25);
        expect(dailySpendCapUsd({ LLM_DAILY_SPEND_CAP_USD: '0' })).toBe(0);
        expect(dailySpendCapUsd({ LLM_DAILY_SPEND_CAP_USD: 'unlimited' })).toBe(10);
    });

    test('assertSpendConfig fails LOUD when the cap is on and prices are missing; passes when disabled or complete', () => {
        expect(() => assertSpendConfig({ LLM_DAILY_SPEND_CAP_USD: '10' })).toThrow(/LLM_PRICE_IN_USD_PER_MTOK/);
        expect(() => assertSpendConfig({ LLM_DAILY_SPEND_CAP_USD: '0' })).not.toThrow();
        expect(() => assertSpendConfig({ LLM_PRICE_IN_USD_PER_MTOK: '3', LLM_PRICE_OUT_USD_PER_MTOK: '15' })).not.toThrow();
    });

    test('the ledger rolls per ET day and accumulates per lane', () => {
        const day1 = rollLedger(null, '2026-09-10');
        expect(day1.date).toBe('2026-09-10');
        expect(day1.totalUsd).toBe(0);
        const a = addUsage(day1, 'trigger', { inputTokens: 100_000, outputTokens: 5_000 }, PRICES);
        const b = addUsage(a, 'cron:Pre-Market Brief', { inputTokens: 50_000, outputTokens: 1_000 }, PRICES);
        expect(b.byLane.trigger.runs).toBe(1);
        expect(b.byLane.trigger.inputTokens).toBe(100_000);
        expect(b.totalUsd).toBeCloseTo(0.3 + 0.075 + 0.15 + 0.015, 6);
        // a new day starts from zero; the old day is not carried
        const day2 = rollLedger(b, '2026-09-11');
        expect(day2.totalUsd).toBe(0);
        expect(Object.keys(day2.byLane)).toHaveLength(0);
        // same day → unchanged
        expect(rollLedger(b, '2026-09-10')).toBe(b);
    });
});

describe('spend cap verdict (REQ-LLM-002 — evaluation lanes stop, exits never)', () => {
    test('evaluation lanes: trigger, breadth, mover, cron:*; not whatsapp/tui/agent', () => {
        expect(isEvaluationLane('trigger')).toBe(true);
        expect(isEvaluationLane('breadth')).toBe(true);
        expect(isEvaluationLane('mover')).toBe(true);
        expect(isEvaluationLane('cron:Market Open Scan')).toBe(true);
        expect(isEvaluationLane('whatsapp')).toBe(false);
        expect(isEvaluationLane('tui')).toBe(false);
        expect(isEvaluationLane('agent')).toBe(false);
        expect(isEvaluationLane(null)).toBe(false);
    });

    test('under the cap → ok; at/over the cap → refused for evaluation lanes only; cap 0 → never refuses', () => {
        const spent = addUsage(rollLedger(null, '2026-09-10'), 'trigger', { inputTokens: 4_000_000, outputTokens: 0 }, PRICES); // $12
        expect(spendVerdict({ lane: 'trigger', ledger: spent, capUsd: 10 }).ok).toBe(false);
        const refused = spendVerdict({ lane: 'trigger', ledger: spent, capUsd: 10 });
        if (!refused.ok) expect(refused.reason).toMatch(/spend cap/);
        expect(spendVerdict({ lane: 'whatsapp', ledger: spent, capUsd: 10 }).ok).toBe(true);
        expect(spendVerdict({ lane: 'trigger', ledger: spent, capUsd: 0 }).ok).toBe(true);
        expect(spendVerdict({ lane: 'trigger', ledger: rollLedger(null, '2026-09-10'), capUsd: 10 }).ok).toBe(true);
    });

    test('REQ-LLM-003 cron reserve: discovery lanes stop at cap − reserve, cron lanes at the cap (the 2026-09-08 Pre-Close Review refusal)', () => {
        const at = (usd: number) => addUsage(rollLedger(null, '2026-09-08'), 'trigger', { inputTokens: (usd / 3) * 1e6, outputTokens: 0 }, PRICES);
        // $8.50 spent, cap 10, reserve 2: the trigger lane is done for the day, the review still runs.
        const trig = spendVerdict({ lane: 'trigger', ledger: at(8.5), capUsd: 10, reserveUsd: 2 });
        expect(trig.ok).toBe(false);
        if (!trig.ok) expect(trig.reason).toMatch(/discovery allowance \$8\.00 .*LLM_SPEND_CRON_RESERVE_USD \$2\.00/);
        expect(spendVerdict({ lane: 'breadth', ledger: at(8.5), capUsd: 10, reserveUsd: 2 }).ok).toBe(false);
        expect(spendVerdict({ lane: 'cron:Pre-Close Review', ledger: at(8.5), capUsd: 10, reserveUsd: 2 }).ok).toBe(true);
        // At the cap everything evaluative stops; operator lanes never do.
        expect(spendVerdict({ lane: 'cron:Pre-Close Review', ledger: at(10.23), capUsd: 10, reserveUsd: 2 }).ok).toBe(false);
        expect(spendVerdict({ lane: 'whatsapp', ledger: at(10.23), capUsd: 10, reserveUsd: 2 }).ok).toBe(true);
        // Reserve 0 (or omitted) is the pre-2026-09-09 behavior; a reserve ≥ cap clamps to the cap (discovery refused from $0).
        expect(spendVerdict({ lane: 'trigger', ledger: at(8.5), capUsd: 10, reserveUsd: 0 }).ok).toBe(true);
        expect(spendVerdict({ lane: 'trigger', ledger: at(8.5), capUsd: 10 }).ok).toBe(true);
        expect(spendVerdict({ lane: 'trigger', ledger: rollLedger(null, '2026-09-08'), capUsd: 10, reserveUsd: 50 }).ok).toBe(false);
        expect(isCronLane('cron:Midday Check')).toBe(true);
        expect(isCronLane('trigger')).toBe(false);
        expect(cronReserveUsd({})).toBe(2);
        expect(cronReserveUsd({ LLM_SPEND_CRON_RESERVE_USD: '3.5' })).toBe(3.5);
        expect(cronReserveUsd({ LLM_SPEND_CRON_RESERVE_USD: '-1' })).toBe(2);
    });

    test('recordLlmUsage persists to llm-spend.json under the data dir and reads back', () => {
        const dir = mkdtempSync(join(tmpdir(), 'dexter-spend-'));
        expect(readSpendLedger(dir)).toBeNull();
        recordLlmUsage('trigger', { inputTokens: 10_000, outputTokens: 500 }, { prices: PRICES, dataDir: dir, today: '2026-09-10' });
        const led = readSpendLedger(dir);
        expect(led?.byLane.trigger.runs).toBe(1);
        expect(led?.totalUsd).toBeCloseTo(0.03 + 0.0075, 6);
        // corrupt file → null (a fresh ledger is rebuilt, never a crash)
        writeSpendLedger(dir, '{oops' as never);
        expect(readSpendLedger(dir)).toBeNull();
    });
});
