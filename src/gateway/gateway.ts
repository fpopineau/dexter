import type { GroupContext } from '../agent/prompts.js';
import { ensureHeartbeatCronJob } from '../cron/heartbeat-migration.js';
import { captureNetLiqBaseline } from '../services/daily-loss-guard.js';
import { startCronRunner } from '../cron/runner.js';
import { ensureTradingCronJobs } from '../cron/trading-schedules.js';
import { isArchiveSchedulerEnabled, startArchiveScheduler, stopArchiveScheduler } from '../services/archive-scheduler.js';
import { isOpportunityEngineEnabled, startOpportunityEngine, stopOpportunityEngine } from '../services/opportunity-engine.js';
import { startOutcomeTracker, stopOutcomeTracker } from '../services/outcome-tracker.js';
import { isUniverseSweepEnabled, startUniverseSweep, stopUniverseSweep } from '../services/universe-sweep.js';
import { getSetting } from '../utils/config.js';
import { logger } from '../utils/index.js';
import { dexterPath } from '../utils/paths.js';
import { enqueueForSession, isSessionRunning, runAgentForMessage } from './agent-runner.js';
import { createChannelManager } from './channels/manager.js';
import {
  assertOutboundAllowed,
  sendComposing,
  sendMessageWhatsApp,
  type WhatsAppInboundMessage,
} from './channels/whatsapp/index.js';
import { createWhatsAppPlugin } from './channels/whatsapp/plugin.js';
import { loadGatewayConfig, type GatewayConfig } from './config.js';
import {
  formatGroupHistoryContext,
  formatGroupMembersList,
  getAndClearGroupHistory,
  isBotMentioned,
  noteGroupMember,
  recordGroupMessage,
} from './group/index.js';
import { registerOutcomeAlerts } from './outcome-alerts.js';
import { handleProposalCommand } from './proposal-commands.js';
import { resolveRoute } from './routing/resolve-route.js';
import { resolveSessionStorePath, upsertSessionMeta } from './sessions/store.js';
import { startBenchmark, stopBenchmark } from '@/services/benchmark.js';
import { startDashboard, stopDashboard } from '@/services/dashboard.js';
import { startEodTriage, stopEodTriage } from '@/services/eod-triage.js';
import { startNewsPulse, stopNewsPulse } from '@/services/news-pulse.js';
import { isAutoExecuteEnabled } from '@/services/proposal-executor.js';
import { plannedBookWorstCasePct } from '@/services/proposal-risk-gate.js';
import { getRiskRules } from '@/tools/ibkr/risk-rules.js';
import { startProfitTrail, stopProfitTrail } from '@/services/profit-trail.js';
import { catchUpPatternScan } from '@/services/pattern-scanner.js';
import { startExcursionSweeper, stopExcursionSweeper } from '@/services/excursion-sweeper.js';
import { startStaleEntrySweeper, stopStaleEntrySweeper } from '@/services/stale-entry-sweeper.js';
import { startFlatExitSweeper, stopFlatExitSweeper } from '@/services/flat-exit-sweeper.js';
import { startEquitySeries, stopEquitySeries } from '@/services/equity-series.js';
import { startKillSwitchGuardian, stopKillSwitchGuardian } from '@/services/kill-switch-guardian.js';
import { startRuntimeAttestation, stopRuntimeAttestation } from '@/services/runtime-attestation.js';
import { startSpreadRecheck, stopSpreadRecheck } from '@/services/spread-recheck.js';
import { startVetoWindowSweeper, stopVetoWindowSweeper } from '@/services/veto-window.js';
import { assertSpendConfig } from '@/services/llm-spend.js';
import { makeDebugLog } from './debug-log.js';
import { registerScanHealthAlerts } from './health-alerts.js';
import { registerTriggerAlerts } from './trigger-alerts.js';
import { registerMoverAlerts } from './mover-alerts.js';
import { cleanMarkdownForWhatsApp } from './utils.js';

// Redacting, size-capped sink (WP0.6) — raw phones/JIDs never hit disk.
const debugLog = makeDebugLog(dexterPath('gateway-debug.log'));

export type GatewayService = {
  stop: () => Promise<void>;
  snapshot: () => Record<string, { accountId: string; running: boolean; connected?: boolean }>;
};

function elide(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

async function handleInbound(cfg: GatewayConfig, inbound: WhatsAppInboundMessage): Promise<void> {
  const bodyPreview = elide(inbound.body.replace(/\n/g, ' '), 50);
  const isGroup = inbound.chatType === 'group';
  console.log(`Inbound message ${inbound.from} (${inbound.chatType}, ${inbound.body.length} chars): "${bodyPreview}"`);
  debugLog(`[gateway] handleInbound from=${inbound.from} isGroup=${isGroup} body="${inbound.body.slice(0, 30)}..."`);

  // --- Group-specific: track member, check mention gating ---
  if (isGroup) {
    noteGroupMember(inbound.chatId, inbound.senderId, inbound.senderName);

    const mentioned = isBotMentioned({
      mentionedJids: inbound.mentionedJids,
      selfJid: inbound.selfJid,
      selfLid: inbound.selfLid,
      selfE164: inbound.selfE164,
      body: inbound.body,
    });
    debugLog(`[gateway] group mention check: mentioned=${mentioned}`);

    if (!mentioned) {
      // Buffer the message for future context but don't reply
      recordGroupMessage(inbound.chatId, {
        senderName: inbound.senderName ?? inbound.senderId,
        senderId: inbound.senderId,
        body: inbound.body,
        timestamp: inbound.timestamp ?? Date.now(),
      });
      debugLog(`[gateway] group message buffered (no mention), skipping reply`);
      return;
    }
  }

  // --- Routing: use chatId for groups (group JID), senderId for DMs ---
  const peerId = isGroup ? inbound.chatId : inbound.senderId;
  const route = resolveRoute({
    cfg,
    channel: 'whatsapp',
    accountId: inbound.accountId,
    peer: { kind: inbound.chatType, id: peerId },
  });

  const storePath = resolveSessionStorePath(route.agentId);
  upsertSessionMeta({
    storePath,
    sessionKey: route.sessionKey,
    channel: 'whatsapp',
    to: inbound.from,
    accountId: route.accountId,
    agentId: route.agentId,
  });

  // Start typing indicator loop to keep it alive during long agent runs
  const TYPING_INTERVAL_MS = 5000; // Refresh every 5 seconds
  let typingTimer: ReturnType<typeof setInterval> | undefined;

  const startTypingLoop = async () => {
    // For groups, use inbound.sendComposing directly (bypasses outbound strict checks)
    if (isGroup) {
      await inbound.sendComposing();
      typingTimer = setInterval(() => { void inbound.sendComposing(); }, TYPING_INTERVAL_MS);
    } else {
      await sendComposing({ to: inbound.replyToJid, accountId: inbound.accountId });
      typingTimer = setInterval(() => {
        void sendComposing({ to: inbound.replyToJid, accountId: inbound.accountId });
      }, TYPING_INTERVAL_MS);
    }
  };

  const stopTypingLoop = () => {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
  };

  try {
    // Defense-in-depth: verify outbound destination is allowed before any messaging
    // For groups, use chatId (the group JID); for DMs, use replyToJid
    const outboundTarget = isGroup ? inbound.chatId : inbound.replyToJid;
    try {
      assertOutboundAllowed({ to: outboundTarget, accountId: inbound.accountId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      debugLog(`[gateway] outbound BLOCKED: ${msg}`);
      console.log(msg);
      return;
    }

    // --- Deterministic trade-proposal commands (DMs only, no LLM) ---
    // An explicit "accept P-XXXX" message IS the human approval: it routes
    // straight to the proposal executor (safety lock + daily-loss kill-switch).
    if (!isGroup) {
      const commandReply = await handleProposalCommand(inbound.body);
      if (commandReply !== null) {
        debugLog(`[gateway] proposal command handled deterministically`);
        await sendMessageWhatsApp({
          to: inbound.replyToJid,
          body: cleanMarkdownForWhatsApp(commandReply).trim(),
          accountId: inbound.accountId,
        });
        return;
      }
    }

    await startTypingLoop();

    // --- Build query: for groups, include buffered history context ---
    let query = inbound.body;
    let groupContext: GroupContext | undefined;

    if (isGroup) {
      const history = getAndClearGroupHistory(inbound.chatId);
      query = formatGroupHistoryContext({
        history,
        currentSenderName: inbound.senderName ?? inbound.senderId,
        currentSenderId: inbound.senderId,
        currentBody: inbound.body,
      });
      debugLog(`[gateway] group query with ${history.length} history entries`);

      const membersList = formatGroupMembersList({
        groupId: inbound.chatId,
        participants: inbound.groupParticipants,
      });
      groupContext = {
        groupName: inbound.groupSubject,
        membersList: membersList || undefined,
        activationMode: 'mention',
      };
    }

    console.log(`Processing message with agent...`);
    const model = getSetting('modelId', 'gpt-5.5') as string;
    const modelProvider = getSetting('provider', 'openai') as string;

    // If agent is already running for this session, enqueue for mid-run injection
    if (isSessionRunning(route.sessionKey)) {
      debugLog(`[gateway] agent busy for session=${route.sessionKey}, enqueueing`);
      enqueueForSession(route.sessionKey, model, query);
      return;
    }

    debugLog(`[gateway] running agent for session=${route.sessionKey}`);
    const startedAt = Date.now();
    const answer = await runAgentForMessage({
      sessionKey: route.sessionKey,
      query,
      model,
      modelProvider,
      channel: 'whatsapp',
      groupContext,
    });
    const durationMs = Date.now() - startedAt;
    debugLog(`[gateway] agent answer length=${answer.length}`);

    // Stop typing loop before sending reply
    stopTypingLoop();

    if (answer.trim()) {
      const cleanedAnswer = cleanMarkdownForWhatsApp(answer).trim();

      if (isGroup) {
        // For groups, use inbound.reply() directly (bypasses outbound strict E.164 checks)
        debugLog(`[gateway] sending group reply to ${inbound.chatId}`);
        await inbound.reply(cleanedAnswer);
      } else {
        debugLog(`[gateway] sending reply to ${inbound.replyToJid}`);
        await sendMessageWhatsApp({
          to: inbound.replyToJid,
          body: cleanedAnswer,
          accountId: inbound.accountId,
        });
      }
      console.log(`Sent reply (${answer.length} chars, ${durationMs}ms)`);
      debugLog(`[gateway] reply sent`);
    } else {
      console.log(`Agent returned empty response (${durationMs}ms)`);
      debugLog(`[gateway] empty answer, notifying`);
      // Never leave the chat hanging: an empty answer usually means the run
      // was absorbed by a follow-up message or ended without output.
      const notice = '⚠️ That run ended without an answer (it may have been absorbed by a follow-up message). Ask again in one message.';
      if (isGroup) {
        await inbound.reply(notice);
      } else {
        await sendMessageWhatsApp({ to: inbound.replyToJid, body: notice, accountId: inbound.accountId });
      }
    }
  } catch (err) {
    stopTypingLoop();
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${msg}`);
    debugLog(`[gateway] ERROR: ${msg}`);
    // Surface failures to the chat instead of dying silently.
    try {
      const notice = `⚠️ Agent run failed: ${msg.slice(0, 200)}`;
      if (isGroup) {
        await inbound.reply(notice);
      } else {
        await sendMessageWhatsApp({ to: inbound.replyToJid, body: notice, accountId: inbound.accountId });
      }
    } catch { /* outbound also failing — nothing more to do */ }
  }
}

export async function startGateway(params: { configPath?: string } = {}): Promise<GatewayService> {
  // Fail-loud rule load at BOOT (WP0.1): a malformed risk-rules file must
  // refuse the gateway here, not explode (or silently default) at the
  // first accept hours later. Throws with the full error list.
  const { getRiskRules } = await import('@/tools/ibkr/risk-rules.js');
  getRiskRules();

  // Calendar cliff check (WP0.5): past the holiday table's last year,
  // every holiday silently becomes a trading day. Loud, not fatal — the
  // gateway still runs, but every boot names the problem.
  const { calendarCoverageStatus } = await import('@/utils/market-hours.js');
  const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const coverage = calendarCoverageStatus(todayEt);
  if (coverage.status === 'expired') {
    logger.error(`[gateway] HOLIDAY TABLE EXPIRED: market-hours.ts covers through ${coverage.lastCoveredYear} — holidays now read as TRADING DAYS. Extend HOLIDAYS/HALF_DAYS before trusting any session logic.`);
  } else if (coverage.status === 'expiring') {
    logger.warn(`[gateway] holiday table ends with ${coverage.lastCoveredYear} — extend market-hours.ts HOLIDAYS/HALF_DAYS before January.`);
  }

  const cfg = loadGatewayConfig(params.configPath);
  const plugin = createWhatsAppPlugin({
    loadConfig: () => loadGatewayConfig(params.configPath),
    onMessage: async (inbound) => {
      const current = loadGatewayConfig(params.configPath);
      await handleInbound(current, inbound);
    },
  });
  const manager = createChannelManager({
    plugin,
    loadConfig: () => loadGatewayConfig(params.configPath),
  });
  await manager.startAll();

  ensureHeartbeatCronJob(params.configPath);
  // REQ-LLM-001 (WP0.1 fail-loud pattern): a spend cap without prices would
  // be a silent no-op — refuse to boot rather than run an unpriced meter.
  assertSpendConfig();
  if (process.env.IBKR_HOST || process.env.IBKR_PORT) {
    ensureTradingCronJobs();
    registerOutcomeAlerts();
    await startOutcomeTracker();
    // Profit trail: auto-close winners that pull back from their peak
    // (alerts bridged to WhatsApp inside registerOutcomeAlerts).
    startProfitTrail();
    // Reclaim position slots from brackets whose entry never filled.
    startStaleEntrySweeper();
    startFlatExitSweeper();
    // Live-loop WP1 seams: the 09:31 ET re-check of deferred pre-open
    // spread checks (REQ-RISK-008) and the veto-window due sweep
    // (REQ-LIVE-002, inert while LIVE_VETO_WINDOW_MIN=0).
    startSpreadRecheck();
    startVetoWindowSweeper();
    // Marked NetLiq series (REQ-VAL-006): the validation scorecard judges
    // PORTFOLIO drawdown from this series, not from closed trades.
    startEquitySeries();
    // Review-31: the gateway attests its OWN profile/account/fingerprint
    // (boot + 90s post-connect + hourly heartbeat) — the scorecard
    // verifies the RUNNING process, not the yaml.
    startRuntimeAttestation();
    // Continuous kill-switch (review 2026-08-23): a breach latches on
    // OBSERVATION, and a latch cancels working entry parents.
    startKillSwitchGuardian();
    // Nightly MFE/MAE backfill on closed rows (WP0.9): target-reachability
    // tuning reads excursion data — without this it tunes on ~4 rows.
    startExcursionSweeper();
    // 15:52 ET: close losing-and-fading DAY positions; keep the rest for
    // the protected-overnight conversion at the bell.
    startEodTriage();
    // ~20-min batched GDELT sweep: news breadth over book + reactors +
    // candidates, surfaced via the news_pulse tool. Read-only context.
    startNewsPulse();
    startBenchmark();
    // Swing-pattern snapshot catch-up: the nightly sweep (whose stage 4
    // produces it) is routinely killed by the nightly restart window —
    // the boot that killed it heals it. Local-only, non-blocking.
    void catchUpPatternScan();
    // Market-data farm warm-up: IBKR's farms connect lazily after the
    // nightly restart — the first snapshot after boot can be stale or
    // empty (2026-08-11 brief: broken quotes on every candidate). A SPY
    // canary absorbs the wake-up before any scheduled brief needs quotes.
    void (async () => {
      try {
        const { createIbkrMarketData } = await import('@/tools/ibkr/market-data.js');
        const raw = await createIbkrMarketData().invoke({ ticker: 'SPY', exchange: 'SMART', currency: 'USD' });
        const d = (JSON.parse(String(raw)) as { data?: { last?: number; bid?: number; ask?: number } }).data;
        debugLog(`[gateway] market-data warm-up: SPY last=${d?.last ?? '—'} bid=${d?.bid ?? '—'} ask=${d?.ask ?? '—'}`);
      } catch (err) {
        debugLog(`[gateway] market-data warm-up failed (farms may lag the first real request): ${err}`);
      }
    })();
    // Local dashboard (http://127.0.0.1:8484) — charts + the live book from
    // dexter's own data; no second IBKR session involved.
    startDashboard();
    // Session NetLiq baseline: the kill-switch's P&L fallback references
    // pre-trading equity. Best-effort; retried on the first gate check.
    void captureNetLiqBaseline();
    // Auto-exec visibility: the score floor and cap silently shape what
    // trades unattended — AUTO_EXECUTE_MIN_SCORE=1 sat undocumented for a
    // month reading like a disabled safety (audit 2026-08-11). State the
    // effective config every boot so it can never be invisible again.
    if (isAutoExecuteEnabled()) {
      // Review 2026-08-21: display the EXECUTOR'S resolution, not a
      // reimplementation — the copies disagreed the day D6 landed (real
      // floor 0, boot banner said 80).
      const { autoExecMinScore, autoExecMaxPerDay } = await import('@/services/proposal-executor.js');
      const floor = autoExecMinScore();
      // REQ-TRIG-004: the executor's OWN resolution of the cap, named beside
      // the yaml's max_daily_trades so a disagreement is visible at boot.
      const cap = autoExecMaxPerDay();
      debugLog(
        `[gateway] auto-execute ON (paper: AUTO_EXECUTE_PAPER; live: additionally the operator's live switch): score floor ${floor}` +
        (floor <= 40 ? ' (burn-in sampling posture — every gate-passing proposal executes; the sizer de-risks low bands)' : '') +
        `, auto-exec cap ${cap}/day, max_daily_trades ${getRiskRules().max_daily_trades}/day; unscored proposals never auto-execute.`,
      );
    }
    // Config coherence: announce when the caps authorize a book whose
    // planned stop-outs alone would breach the kill-switch — the
    // acceptance-time headroom gate then binds BEFORE the position caps,
    // which must never surprise the operator mid-session.
    {
      const rules = getRiskRules();
      const worstCase = plannedBookWorstCasePct(rules);
      if (worstCase > rules.max_daily_loss_pct) {
        debugLog(
          `[gateway] RISK-CONFIG WARNING: the class caps authorize a planned book worst case of ` +
          `${worstCase}% of NetLiq, over the ${rules.max_daily_loss_pct}% daily-loss kill-switch — ` +
          `the daily-loss headroom gate will refuse acceptances before the position caps fill. ` +
          `Align max_daily_loss_pct with the class budgets (risk-rules yaml) or accept the tighter effective book.`,
        );
      }
      // Empty intraday geometry band: the tightest legal stop already
      // demands a target past the reachability cap — every ATR-checked
      // intraday proposal would be refused, which looks like a dead pipeline
      // rather than a config contradiction.
      if (rules.max_target_atr > 0
        && rules.min_stop_atr_fraction * rules.min_risk_reward > rules.max_target_atr) {
        debugLog(
          `[gateway] RISK-CONFIG WARNING: min_stop_atr_fraction (${rules.min_stop_atr_fraction}) × ` +
          `min_risk_reward (${rules.min_risk_reward}) exceeds max_target_atr (${rules.max_target_atr}) — ` +
          `the intraday stop/target band is EMPTY and every proposal with ATR context will be refused. ` +
          `Raise max_target_atr or lower the other two (risk-rules yaml).`,
        );
      }
    }
    if (isOpportunityEngineEnabled()) {
      registerTriggerAlerts();
      registerScanHealthAlerts();
      registerMoverAlerts();
      startOpportunityEngine();
    }
    if (isArchiveSchedulerEnabled()) {
      startArchiveScheduler();
    }
    if (isUniverseSweepEnabled()) {
      startUniverseSweep();
    }
  }
  const cron = startCronRunner({ configPath: params.configPath });

  return {
    stop: async () => {
      cron.stop();
      stopUniverseSweep();
      stopArchiveScheduler();
      stopOpportunityEngine();
      stopOutcomeTracker();
      // Audit finding C: these five kept running after "shutdown" —
      // profit-trail and EOD triage can place market orders post-stop.
      stopProfitTrail();
      stopStaleEntrySweeper();
      stopFlatExitSweeper();
      stopSpreadRecheck();
      stopVetoWindowSweeper();
      stopEquitySeries();
      stopKillSwitchGuardian();
      stopExcursionSweeper();
      stopEodTriage();
      stopNewsPulse();
      stopBenchmark();
      stopDashboard();
      // Review-33/34: EVERY synchronous stop signal above fires before
      // this await — the attestation write fingerprints the whole
      // strategy surface (git subprocesses, seconds under load) and an
      // order-capable timer like EOD triage must not stay scheduled
      // while it runs. Awaited BEFORE manager.stopAll() so the stopped
      // record can still resolve the verified account; the write chain
      // blocks any in-flight heartbeat from burying the marker.
      const stopMarkerOnDisk = await stopRuntimeAttestation();
      await manager.stopAll();
      if (!stopMarkerOnDisk) {
        // Review-34: the write swallows persistence errors into null —
        // surfaced HERE, after the rest of shutdown completed, so the
        // operator knows the on-disk record still claims a running
        // gateway until it goes stale (~45 min).
        logger.error(
          '[gateway] shutdown finished WITHOUT a stopped attestation marker — the write failed; ' +
          '.dexter/data/runtime-attestation.json still reads as a running gateway until it goes stale (~45 min)',
        );
      }
    },
    snapshot: () => manager.getSnapshot(),
  };
}

