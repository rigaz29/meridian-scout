/**
 * Rule-based filtering — the cheap, deterministic gate before the LLM.
 *
 * Stage 1 uses Meteora-only data and runs BEFORE enrichment (so we don't spend
 * Jupiter/OKX calls on pools that can't pass anyway). Stage 2 uses enrichment
 * data and runs after. Any stage-2 rule whose input is missing (provider down)
 * is *skipped*, not failed — enrichment is best-effort and must never turn a
 * transient outage into a rejection.
 */
import { rules as defaultRules, type Rules } from "../config/rules.js";
import type { EnrichedToken, FilterResult, MeteoraPool } from "../types.js";

/**
 * Stage 1 — Meteora-only quantitative gate. Most numeric bands are already
 * enforced server-side by the discovery API (see fetcher/meteora.ts); these are
 * cheap local backstops that skip whenever the underlying field is missing
 * (never reject on absent data).
 */
export function stage1Filter(pool: MeteoraPool, rules: Rules = defaultRules): FilterResult {
  const r = rules.stage1;
  const reasons: string[] = [];

  if (r.rejectBlacklisted && pool.isBlacklisted) reasons.push("flagged is_blacklisted by Meteora");
  if (rules.blacklist.tokenMints.includes(pool.target.mint)) reasons.push("token mint in manual blacklist");
  if (pool.target.dev && rules.blacklist.devAddresses.includes(pool.target.dev))
    reasons.push("dev/deployer in manual blacklist");

  if (r.maxPoolAgeHours > 0 && pool.ageHours > r.maxPoolAgeHours)
    reasons.push(`pool age ${pool.ageHours.toFixed(1)}h > max ${r.maxPoolAgeHours}h`);

  // Liquidity / activity bands
  if (pool.tvlUsd < r.minTvlUsd)
    reasons.push(`TVL $${pool.tvlUsd.toFixed(0)} < min $${r.minTvlUsd}`);
  if (r.maxTvlUsd > 0 && pool.tvlUsd > r.maxTvlUsd)
    reasons.push(`TVL $${pool.tvlUsd.toFixed(0)} > max $${r.maxTvlUsd}`);
  if (pool.volumeWindowUsd < r.minVolumeUsd)
    reasons.push(`volume $${pool.volumeWindowUsd.toFixed(0)} < min $${r.minVolumeUsd}`);
  if (r.minVolumeToTvlRatio > 0 && pool.volumeToTvlRatio < r.minVolumeToTvlRatio)
    reasons.push(`vol/TVL ${pool.volumeToTvlRatio.toFixed(2)} < min ${r.minVolumeToTvlRatio}`);
  if (r.minFeeTvlRatioPct > 0 && pool.feeTvlRatioPct !== null && pool.feeTvlRatioPct < r.minFeeTvlRatioPct)
    reasons.push(`fee/TVL ${pool.feeTvlRatioPct.toFixed(2)}% < min ${r.minFeeTvlRatioPct}%`);

  // Market-cap band (target token)
  const mcap = pool.target.marketCapUsd;
  if (mcap != null && r.minMcapUsd > 0 && mcap < r.minMcapUsd)
    reasons.push(`mcap $${mcap.toFixed(0)} < min $${r.minMcapUsd}`);
  if (mcap != null && r.maxMcapUsd > 0 && mcap > r.maxMcapUsd)
    reasons.push(`mcap $${mcap.toFixed(0)} > max $${r.maxMcapUsd}`);

  // Bin-step band
  if (pool.binStep != null && r.minBinStep > 0 && pool.binStep < r.minBinStep)
    reasons.push(`bin step ${pool.binStep} < min ${r.minBinStep}`);
  if (pool.binStep != null && r.maxBinStep > 0 && pool.binStep > r.maxBinStep)
    reasons.push(`bin step ${pool.binStep} > max ${r.maxBinStep}`);

  // Volatility ceiling
  if (r.maxVolatility != null && r.maxVolatility > 0 && pool.volatility != null && pool.volatility > r.maxVolatility)
    reasons.push(`volatility ${pool.volatility.toFixed(2)} > max ${r.maxVolatility}`);

  // Rug-safety: token authorities should be revoked.
  if (r.requireMintAuthorityRevoked && pool.target.hasMintAuthority === true)
    reasons.push("mint authority still active (supply can be inflated)");
  if (r.requireFreezeAuthorityRevoked && pool.target.hasFreezeAuthority === true)
    reasons.push("freeze authority still active (wallets can be frozen)");
  if (r.maxTopHoldersPct > 0 && pool.target.topHoldersPct != null && pool.target.topHoldersPct > r.maxTopHoldersPct)
    reasons.push(`top holders ${pool.target.topHoldersPct.toFixed(1)}% > max ${r.maxTopHoldersPct}%`);

  return { passed: reasons.length === 0, reasons, skipped: [] };
}

/** Best holder count available across sources. */
function resolveHolders(t: EnrichedToken): number | null {
  return t.jupiter?.holders ?? t.pool.target.holders ?? t.okx?.holders ?? null;
}

/** Best current price available across sources. */
function resolvePrice(t: EnrichedToken): number | null {
  return t.jupiter?.priceUsd ?? t.gmgn?.priceUsd ?? t.okx?.priceUsd ?? t.pool.target.priceUsd ?? null;
}

/** Best top-10 concentration (%) — GMGN/OKX exclude CEX/pool wallets. */
function resolveTop10Pct(t: EnrichedToken): number | null {
  return t.gmgn?.top10Pct ?? t.okx?.top10Pct ?? t.jupiter?.audit?.topHoldersPct ?? null;
}

/** Stage 2 — enrichment-dependent gate (Jupiter + OKX). */
export function stage2Filter(token: EnrichedToken, rules: Rules = defaultRules): FilterResult {
  const r = rules.stage2;
  const reasons: string[] = [];
  const skipped: string[] = [];
  const jup = token.jupiter;

  // Jupiter listing / verification
  if (r.requireJupiterListed) {
    if (!jup) skipped.push("jupiter-listed (provider unavailable)");
    else if (!jup.listed) reasons.push("not listed on Jupiter");
  }
  if (r.requireJupiterVerified) {
    if (!jup) skipped.push("jupiter-verified (provider unavailable)");
    else if (!jup.verified) reasons.push("not Jupiter-verified");
  }

  // Slippage on the probe swap
  if (!jup || jup.slippagePct === null) {
    skipped.push("slippage (no Jupiter quote)");
  } else if (jup.slippagePct > r.maxSlippagePct) {
    reasons.push(
      `slippage ${jup.slippagePct.toFixed(2)}% > max ${r.maxSlippagePct}% (on $${jup.slippageProbeUsd} swap)`,
    );
  }

  // Cross-DEX price sync (Jupiter vs OKX)
  if (token.priceDiffPct === null) {
    skipped.push("price-sync (need both Jupiter + OKX prices)");
  } else if (token.priceDiffPct > r.maxJupiterOkxPriceDiffPct) {
    reasons.push(`Jup/OKX price diff ${token.priceDiffPct.toFixed(2)}% > max ${r.maxJupiterOkxPriceDiffPct}%`);
  }

  // Holder floor (disabled when minHolders = 0)
  if (r.minHolders > 0) {
    const holders = resolveHolders(token);
    if (holders === null) skipped.push("min-holders (holder count unknown)");
    else if (holders < r.minHolders) reasons.push(`holders ${holders} < min ${r.minHolders}`);
  }

  // Top-10 concentration (GMGN/OKX)
  if (r.maxTop10Pct > 0) {
    const top10 = resolveTop10Pct(token);
    if (top10 === null) skipped.push("top10-concentration (no GMGN/OKX data)");
    else if (top10 > r.maxTop10Pct) reasons.push(`top10 ${top10.toFixed(1)}% > max ${r.maxTop10Pct}%`);
  }

  // ATH-distance gates (need GMGN ath_price + a current price)
  if (r.athFilterPct !== null || r.maxAthDropPct !== null) {
    const ath = token.gmgn?.athPriceUsd ?? null;
    const price = resolvePrice(token);
    if (ath === null || ath <= 0 || price === null) {
      skipped.push("ath-distance (no GMGN ath_price / price)");
    } else {
      const pctOfAth = (price / ath) * 100; // 100 = at ATH, 20 = down 80%
      // athFilterPct -20 → must be <= 80% of ATH (don't buy the top).
      if (r.athFilterPct !== null && pctOfAth > 100 + r.athFilterPct)
        reasons.push(`price ${pctOfAth.toFixed(0)}% of ATH > ${100 + r.athFilterPct}% (too close to ATH)`);
      // maxAthDropPct 75 → reject if down > 75% (<= 25% of ATH; dumped).
      if (r.maxAthDropPct !== null && 100 - pctOfAth > r.maxAthDropPct)
        reasons.push(`down ${(100 - pctOfAth).toFixed(0)}% from ATH > max ${r.maxAthDropPct}%`);
    }
  }

  return { passed: reasons.length === 0, reasons, skipped };
}
