/**
 * One screening cycle:
 *
 *   fetch pools → drop already-seen → stage-1 rules (Meteora-only)
 *     → enrich (Jupiter + OKX) → stage-2 rules → LLM deep-dive
 *     → notify top scorers on Telegram → persist state
 *
 * Every stage logs a count so a glance at the logs tells you where candidates
 * dropped off. A failure in enrichment or the LLM for one token is contained to
 * that token — the cycle always completes.
 */
import { createLogger } from "./util/logger.js";
import { rules } from "./config/rules.js";
import { fetchRecentPools } from "./fetcher/meteora.js";
import { enrichToken } from "./enrichment/index.js";
import { stage1Filter, stage2Filter } from "./filters/index.js";
import { analyzeToken } from "./analyzer/llm.js";
import { sendCandidate } from "./notifier/telegram.js";
import type { SentStore } from "./storage/index.js";
import type { EnrichedToken, ScreenedCandidate } from "./types.js";

const log = createLogger("cycle");

const ENRICH_CONCURRENCY = 3;

/** Map with bounded concurrency (keeps us under third-party rate limits). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface CycleStats {
  fetched: number;
  fresh: number;
  stage1Pass: number;
  enriched: number;
  stage2Pass: number;
  analyzed: number;
  notified: number;
  durationMs: number;
}

export async function runCycle(store: SentStore): Promise<CycleStats> {
  const startedAt = Date.now();
  log.info("─".repeat(48));
  log.info("screening cycle started");

  // 1. Fetch
  const pools = await fetchRecentPools();

  // 2. Dedupe — skip pools already processed in a previous cycle
  const fresh = pools.filter((p) => !store.has(p.poolAddress));
  log.info(`new (unseen) pools: ${fresh.length} / ${pools.length}`);

  // 3. Stage-1 filter (cheap, Meteora-only)
  const stage1Pass = fresh.filter((p) => {
    const res = stage1Filter(p);
    if (!res.passed) log.debug(`stage1 reject ${p.target.symbol}: ${res.reasons.join("; ")}`);
    return res.passed;
  });
  log.info(`passed stage-1 rules: ${stage1Pass.length}`);
  if (stage1Pass.length === 0) return finish(startedAt, pools.length, fresh.length, 0, 0, 0, 0, 0);

  // 4. Enrich (Jupiter + OKX), bounded concurrency
  const enriched = await mapLimit(stage1Pass, ENRICH_CONCURRENCY, enrichToken);
  log.info(`enriched: ${enriched.length}`);

  // 5. Stage-2 filter (enrichment-dependent)
  const stage2Pass = enriched.filter((e) => {
    const res = stage2Filter(e);
    if (res.skipped.length) log.debug(`stage2 skipped rules for ${e.pool.target.symbol}: ${res.skipped.join("; ")}`);
    if (!res.passed) log.debug(`stage2 reject ${e.pool.target.symbol}: ${res.reasons.join("; ")}`);
    return res.passed;
  });
  log.info(`passed stage-2 rules: ${stage2Pass.length}`);

  // 6. Cap the number of LLM calls; prioritize the most active pools
  const forLlm = [...stage2Pass]
    .sort((a, b) => b.pool.volumeWindowUsd - a.pool.volumeWindowUsd)
    .slice(0, rules.analyzer.enabled ? rules.analyzer.maxCandidatesPerCycle : 0);

  // 7. LLM deep-dive
  const analyzed: { token: EnrichedToken; candidate: ScreenedCandidate }[] = [];
  for (const e of forLlm) {
    const res = await analyzeToken(e);
    if (!res) continue; // transient LLM failure — leave unmarked so it retries next cycle
    analyzed.push({ token: e, candidate: { ...e, verdict: res.verdict, llmProvider: res.provider } });
  }
  log.info(`analyzed by LLM: ${analyzed.length}`);

  // 8. Decide notifications — score threshold, then per-cycle flood cap
  const passing = analyzed
    .filter((a) => a.candidate.verdict.score >= rules.analyzer.minScoreToNotify)
    .sort((a, b) => b.candidate.verdict.score - a.candidate.verdict.score);
  const toSend = passing.slice(0, rules.notifier.maxNotificationsPerCycle);

  // 9. Send + persist state
  const sentAddrs = new Set<string>();
  const erroredAddrs = new Set<string>();
  for (const a of toSend) {
    const addr = a.candidate.pool.poolAddress;
    try {
      await sendCandidate(a.candidate);
      store.markProcessed(addr, { symbol: a.candidate.pool.target.symbol, score: a.candidate.verdict.score, notified: true });
      sentAddrs.add(addr);
    } catch (err) {
      erroredAddrs.add(addr);
      log.error(`failed to send Telegram alert for ${a.candidate.pool.target.symbol}`, err);
    }
  }

  // Mark the rest of the analyzed pools as processed (so we don't re-spend the
  // LLM on them next cycle). Skip any that errored on send — retry those later.
  for (const a of analyzed) {
    const addr = a.candidate.pool.poolAddress;
    if (sentAddrs.has(addr) || erroredAddrs.has(addr)) continue;
    store.markProcessed(addr, { symbol: a.candidate.pool.target.symbol, score: a.candidate.verdict.score, notified: false });
  }
  store.save();

  return finish(
    startedAt,
    pools.length,
    fresh.length,
    stage1Pass.length,
    enriched.length,
    stage2Pass.length,
    analyzed.length,
    sentAddrs.size,
  );
}

function finish(
  startedAt: number,
  fetched: number,
  fresh: number,
  stage1Pass: number,
  enriched: number,
  stage2Pass: number,
  analyzed: number,
  notified: number,
): CycleStats {
  const stats: CycleStats = {
    fetched,
    fresh,
    stage1Pass,
    enriched,
    stage2Pass,
    analyzed,
    notified,
    durationMs: Date.now() - startedAt,
  };
  log.info(
    `cycle done in ${(stats.durationMs / 1000).toFixed(1)}s — ` +
      `fetched ${fetched}, new ${fresh}, stage1 ${stage1Pass}, stage2 ${stage2Pass}, analyzed ${analyzed}, notified ${notified}`,
  );
  return stats;
}
