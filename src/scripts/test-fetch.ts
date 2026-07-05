/**
 * Manual smoke test for the Meteora fetcher. Run: `npm run test:fetch`
 * Fetches live pools and prints a compact table of the newest candidates.
 */
import "dotenv/config";
import { fetchRecentPools } from "../fetcher/meteora.js";
import { rules } from "../config/rules.js";

function fmtUsd(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

async function main() {
  console.log(`Fetching Meteora pools (pool-discovery, pageSize=${rules.fetcher.pageSize}, timeframe=${rules.fetcher.timeframe})...\n`);
  const pools = await fetchRecentPools();

  const sorted = [...pools].sort((a, b) => a.ageHours - b.ageHours);
  console.log(`\nTotal candidate pools (one target vs one quote): ${pools.length}`);
  console.log(`Showing 15 youngest:\n`);
  console.log(
    ["TOKEN".padEnd(12), "AGE(h)".padStart(7), "TVL".padStart(9), `VOL(${rules.fetcher.timeframe})`.padStart(9), "V/TVL".padStart(6), "HOLDERS".padStart(8), "VERIF"].join(
      "  ",
    ),
  );
  console.log("-".repeat(70));
  for (const p of sorted.slice(0, 15)) {
    console.log(
      [
        p.target.symbol.slice(0, 12).padEnd(12),
        p.ageHours.toFixed(1).padStart(7),
        fmtUsd(p.tvlUsd).padStart(9),
        fmtUsd(p.volumeWindowUsd).padStart(9),
        p.volumeToTvlRatio.toFixed(2).padStart(6),
        String(p.target.holders ?? "—").padStart(8),
        (p.target.isVerified ? "yes" : "no").padStart(5),
      ].join("  "),
    );
  }

  const first = sorted[0];
  if (first) {
    console.log(`\nFull object for youngest pool (${first.name}):`);
    console.log(JSON.stringify(first, null, 2));
  }
}

main().catch((err) => {
  console.error("test:fetch failed:", err);
  process.exit(1);
});
