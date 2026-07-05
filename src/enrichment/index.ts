/**
 * Enrichment orchestrator — combines Jupiter + OKX data onto a Meteora pool.
 *
 * Both providers are queried in parallel and are strictly best-effort: if one
 * (or both) is down, we record a warning and continue with whatever we have.
 * The only derived field is `priceDiffPct` (Jupiter vs OKX), computed when both
 * prices are present.
 */
import { createLogger } from "../util/logger.js";
import { env } from "../config/env.js";
import { rules } from "../config/rules.js";
import { enrichWithJupiter } from "./jupiter.js";
import { enrichWithOkx } from "./okx.js";
import { enrichWithGmgn } from "./gmgn.js";
import type { EnrichedToken, MeteoraPool } from "../types.js";

const log = createLogger("enrich");

export async function enrichToken(pool: MeteoraPool): Promise<EnrichedToken> {
  const mint = pool.target.mint;
  const probeUsd = rules.stage2.slippageProbeUsd;
  const warnings: string[] = [];

  const [jupRes, okxRes, gmgnRes] = await Promise.allSettled([
    enrichWithJupiter(mint, probeUsd),
    enrichWithOkx(mint),
    enrichWithGmgn(mint),
  ]);

  const jupiter = jupRes.status === "fulfilled" ? jupRes.value : null;
  if (jupRes.status === "rejected") {
    warnings.push("jupiter enrichment errored");
    log.warn(`jupiter failed for ${pool.target.symbol}`, jupRes.reason);
  } else if (jupiter === null) {
    warnings.push("jupiter unavailable");
  }

  const okx = okxRes.status === "fulfilled" ? okxRes.value : null;
  if (okxRes.status === "rejected") {
    warnings.push("okx enrichment errored");
    log.warn(`okx failed for ${pool.target.symbol}`, okxRes.reason);
  } else if (okx === null) {
    warnings.push(env.okx.enabled ? "okx unavailable" : "okx disabled (no API keys)");
  }

  const gmgn = gmgnRes.status === "fulfilled" ? gmgnRes.value : null;
  if (gmgnRes.status === "rejected") {
    warnings.push("gmgn enrichment errored");
    log.warn(`gmgn failed for ${pool.target.symbol}`, gmgnRes.reason);
  } else if (gmgn === null) {
    warnings.push(env.gmgn.enabled ? "gmgn unavailable" : "gmgn disabled (no API key)");
  }

  let priceDiffPct: number | null = null;
  const jp = jupiter?.priceUsd ?? null;
  const op = okx?.priceUsd ?? null;
  if (jp !== null && op !== null && jp > 0 && op > 0) {
    const mid = (jp + op) / 2;
    priceDiffPct = (Math.abs(jp - op) / mid) * 100;
  }

  return { pool, jupiter, okx, gmgn, priceDiffPct, enrichmentWarnings: warnings };
}
