/**
 * Rule/threshold configuration — loaded from config.yaml and validated with
 * zod. Every value has a sane default, so a missing or partial config.yaml
 * still yields a working screener. Edit config.yaml (not code) to tune.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { createLogger } from "../util/logger.js";

const log = createLogger("config");

const RulesSchema = z.object({
  fetcher: z
    .object({
      // How many pools to pull per cycle from the (server-filtered) discovery API.
      pageSize: z.number().int().positive().max(200).default(50),
      // Timeframe window the returned volume/fee/volatility numbers are measured
      // over. Meteora supports: 5m, 15m, 30m, 1h, 2h, 4h, 12h, 24h.
      timeframe: z.enum(["5m", "15m", "30m", "1h", "2h", "4h", "12h", "24h"]).default("4h"),
      // Discovery category — how the API ranks/selects pools:
      //   "top"      = highest fee/TVL, "trending" = gaining activity,
      //   "new"      = recently created,  "all" = widest net.
      category: z.enum(["all", "new", "trending", "top"]).default("trending"),
      // Optional explicit sort (e.g. "pool_created_at:desc"). Empty = let the
      // category rank the results (the trending/top ordering meridian relies on).
      sortBy: z.string().default(""),
      quoteMints: z
        .array(z.string())
        .default([
          "So11111111111111111111111111111111111111112",
          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        ]),
    })
    .default({}),
  stage1: z
    .object({
      // Most of these are pushed to Meteora's discovery API as a server-side
      // `filter_by` (see fetcher/meteora.ts) AND re-checked client-side as a
      // backstop. `0`/`null` disables the corresponding gate.
      minTvlUsd: z.number().nonnegative().default(1000),
      maxTvlUsd: z.number().nonnegative().default(500000), // 0 = no cap
      // Min trade volume (USD) over the fetcher `timeframe` window.
      minVolumeUsd: z.number().nonnegative().default(1000),
      // vol/TVL activity ratio (over `timeframe`). Meridian relies on fee/TVL instead — 0 = off.
      minVolumeToTvlRatio: z.number().nonnegative().default(0),
      // Fee/active-TVL floor (%) over `timeframe` — a DLMM pool's core quality
      // metric. Scale with the timeframe (meridian uses 2.5 over 4h). 0 = off.
      minFeeTvlRatioPct: z.number().nonnegative().default(2.5),
      // Base-token market cap band (USD). 0 = that side of the band is off.
      minMcapUsd: z.number().nonnegative().default(250000),
      maxMcapUsd: z.number().nonnegative().default(100000000),
      // Min base-token holder count. 0 = off.
      minHolders: z.number().int().nonnegative().default(500),
      // Min Jupiter organic score (0–100) for the base / quote token. 0 = off.
      minOrganicScore: z.number().nonnegative().default(65),
      minQuoteOrganicScore: z.number().nonnegative().default(60),
      // DLMM bin-step band. 0 = that bound is off.
      minBinStep: z.number().nonnegative().default(80),
      maxBinStep: z.number().nonnegative().default(125),
      // Token-age band (hours since the *token* was created). null = off.
      minTokenAgeHours: z.number().nonnegative().nullable().default(null),
      maxTokenAgeHours: z.number().positive().nullable().default(null),
      // Max *pool* age (hours). 0 = off. Meridian keys off token age, not pool
      // age, so this defaults off — turn it on to bias toward fresh pools.
      maxPoolAgeHours: z.number().nonnegative().default(0),
      // Max pool volatility over `timeframe` (~0–5 typical, 5+ high). null/0 = off.
      maxVolatility: z.number().nonnegative().nullable().default(8),
      // Rug-safety: reject tokens whose mint/freeze authority is still active.
      requireMintAuthorityRevoked: z.boolean().default(true),
      requireFreezeAuthorityRevoked: z.boolean().default(true),
      // Max Meteora top-holder concentration (%). 0 = off (its top_holders_pct
      // can include CEX/pool wallets — see stage2.maxTop10Pct for the OKX/GMGN
      // version that excludes those).
      maxTopHoldersPct: z.number().nonnegative().default(0),
      rejectBlacklisted: z.boolean().default(true),
    })
    .default({}),
  stage2: z
    .object({
      requireJupiterListed: z.boolean().default(true),
      requireJupiterVerified: z.boolean().default(false),
      maxSlippagePct: z.number().positive().default(5),
      slippageProbeUsd: z.number().positive().default(200),
      maxJupiterOkxPriceDiffPct: z.number().positive().default(3),
      minHolders: z.number().int().nonnegative().default(0),
      // Max top-10 holder concentration (%), from GMGN/OKX (excludes CEX/pool
      // wallets). 0 = off. Skipped when no provider supplies it.
      maxTop10Pct: z.number().nonnegative().default(60),
      // ATH gates (need GMGN ath_price). athFilterPct: only pass if price is at
      // least this % BELOW ATH, e.g. -20 → price must be ≤ 80% of ATH (avoid
      // buying the top). maxAthDropPct: reject if price has fallen more than this
      // % from ATH (dead/dumped), e.g. 75 → reject if ≤ 25% of ATH. null = off.
      athFilterPct: z.number().nullable().default(-20),
      maxAthDropPct: z.number().positive().nullable().default(75),
    })
    .default({}),
  analyzer: z
    .object({
      enabled: z.boolean().default(true),
      minScoreToNotify: z.number().int().min(0).max(100).default(60),
      maxCandidatesPerCycle: z.number().int().positive().default(12),
    })
    .default({}),
  notifier: z
    .object({
      maxNotificationsPerCycle: z.number().int().positive().default(5),
      meteoraPoolBaseUrl: z.string().default("https://app.meteora.ag/dlmm"),
      dexscreenerBaseUrl: z.string().default("https://dexscreener.com/solana"),
    })
    .default({}),
  blacklist: z
    .object({
      tokenMints: z.array(z.string()).default([]),
      devAddresses: z.array(z.string()).default([]),
    })
    .default({}),
});

export type Rules = z.infer<typeof RulesSchema>;

function defaultConfigPath(): string {
  // config.yaml lives at the project root, i.e. two levels up from dist/src/config.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../config.yaml");
}

export function loadRules(path = process.env.CONFIG_PATH || defaultConfigPath()): Rules {
  let raw: unknown = {};
  try {
    raw = parseYaml(readFileSync(path, "utf8")) ?? {};
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`Could not read ${path} (${reason}) — falling back to built-in defaults`);
  }
  const parsed = RulesSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid config.yaml:\n${issues}`);
  }
  return parsed.data;
}

export const rules = loadRules();
