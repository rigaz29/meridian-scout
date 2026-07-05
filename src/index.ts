/**
 * Entrypoint + scheduler.
 *
 *   npm start           → run on a node-cron schedule (POLL_INTERVAL_MINUTES)
 *   npm run once        → run exactly one cycle and exit (tsx src/index.ts --once)
 *
 * The cycle is fully guarded: any error is logged and the scheduler keeps
 * running. Overlapping ticks are skipped if a cycle runs long.
 */
import "dotenv/config";
import cron from "node-cron";
import { createLogger } from "./util/logger.js";
import { env, assertRuntimeReady } from "./config/env.js";
import { rules } from "./config/rules.js";
import { llmConfigured } from "./analyzer/llm.js";
import { SentStore } from "./storage/index.js";
import { runCycle } from "./pipeline.js";

const log = createLogger("main");

/** Build a node-cron expression for an N-minute interval. */
function cronExpr(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `*/${m} * * * *`;
  const hours = Math.max(1, Math.round(m / 60));
  return `0 */${hours} * * *`;
}

function logStartupSummary(): void {
  log.info("meridian-scout starting");
  log.info(`  poll interval : ${env.pollIntervalMinutes} min`);
  log.info(`  LLM model     : ${env.llm.model}${env.llm.deepseekApiKey ? " (+ DeepSeek fallback)" : ""}`);
  log.info(`  LLM ready     : ${llmConfigured() ? "yes" : "NO — set OPENROUTER_API_KEY/DEEPSEEK_API_KEY"}`);
  log.info(`  OKX enrich    : ${env.okx.enabled ? "enabled" : "disabled (no keys)"}`);
  log.info(`  GMGN enrich   : ${env.gmgn.enabled ? "enabled" : "disabled (no key)"}`);
  log.info(`  Jupiter key   : ${env.jupiter.apiKey ? "set" : "keyless (free tier)"}`);
  log.info(`  source        : category=${rules.fetcher.category}, timeframe=${rules.fetcher.timeframe}`);
  log.info(
    `  stage-1       : TVL $${rules.stage1.minTvlUsd}-${rules.stage1.maxTvlUsd || "∞"}, vol>=$${rules.stage1.minVolumeUsd}, mcap $${rules.stage1.minMcapUsd}-${rules.stage1.maxMcapUsd || "∞"}, fee/TVL>=${rules.stage1.minFeeTvlRatioPct}%, holders>=${rules.stage1.minHolders}, binStep ${rules.stage1.minBinStep}-${rules.stage1.maxBinStep}`,
  );
  log.info(`  notify score  : >= ${rules.analyzer.minScoreToNotify}  (max ${rules.notifier.maxNotificationsPerCycle}/cycle)`);
}

async function main(): Promise<void> {
  const runOnce = process.argv.includes("--once");

  try {
    assertRuntimeReady();
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  logStartupSummary();
  const store = new SentStore();
  log.info(`state loaded: ${store.size} pools already seen`);

  let running = false;
  const runGuarded = async () => {
    if (running) {
      log.warn("previous cycle still running — skipping this tick");
      return;
    }
    running = true;
    try {
      await runCycle(store);
    } catch (err) {
      log.error("cycle failed", err);
    } finally {
      running = false;
    }
  };

  if (runOnce) {
    await runGuarded();
    log.info("done (--once)");
    return;
  }

  const expr = cronExpr(env.pollIntervalMinutes);
  if (!cron.validate(expr)) {
    log.error(`invalid cron expression derived: "${expr}"`);
    process.exit(1);
  }
  const task = cron.schedule(expr, runGuarded);
  log.info(`scheduled with cron "${expr}"`);

  const shutdown = (sig: string) => {
    log.info(`received ${sig} — shutting down`);
    task.stop();
    store.save();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  if (env.runOnStartup) {
    log.info("running initial cycle on startup");
    await runGuarded();
  }
}

main().catch((err) => {
  log.error("fatal error in main", err);
  process.exit(1);
});
