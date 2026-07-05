/**
 * Manual smoke test for the enrichment layer. Run: `npm run test:enrich`
 * Fetches a few live pools, enriches them via Jupiter + OKX, and prints results.
 * Pass a mint address as an argument to enrich a specific token instead.
 */
import "dotenv/config";
import { fetchRecentPools } from "../fetcher/meteora.js";
import { enrichToken } from "../enrichment/index.js";
import { env } from "../config/env.js";
import type { MeteoraPool } from "../types.js";

async function main() {
  const mintArg = process.argv[2];
  console.log(`OKX enrichment: ${env.okx.enabled ? "enabled (keys present)" : "disabled (no keys — will be skipped)"}\n`);

  let pools: MeteoraPool[];
  if (mintArg) {
    const all = await fetchRecentPools();
    pools = all.filter((p) => p.target.mint === mintArg).slice(0, 1);
    if (!pools.length) {
      console.log(`Mint ${mintArg} not found among current candidate pools; enriching top pool instead.`);
      pools = all.slice(0, 1);
    }
  } else {
    const all = await fetchRecentPools();
    pools = [...all].sort((a, b) => b.volumeWindowUsd - a.volumeWindowUsd).slice(0, 3);
  }

  for (const pool of pools) {
    console.log(`\n=== ${pool.name} (${pool.target.mint}) ===`);
    const enriched = await enrichToken(pool);
    console.log(`Warnings: ${enriched.enrichmentWarnings.join(", ") || "none"}`);
    console.log("Jupiter:", JSON.stringify(enriched.jupiter, null, 2));
    console.log("OKX:", JSON.stringify(enriched.okx, null, 2));
    console.log("priceDiffPct (Jup vs OKX):", enriched.priceDiffPct);
  }
}

main().catch((err) => {
  console.error("test:enrich failed:", err);
  process.exit(1);
});
