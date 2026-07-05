/**
 * Prompt construction for the LLM deep-dive. Produces a compact, structured
 * snapshot of every metric we gathered (Meteora + Jupiter + OKX + GMGN) plus the
 * system/user messages. The model is asked for a strict JSON verdict — analysis
 * and scoring only, never an execution/trading decision.
 */
import type { EnrichedToken } from "../types.js";
import { rules } from "../config/rules.js";

const round = (n: number | null | undefined, dp = 4): number | null =>
  n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toFixed(dp));

/** Flatten an enriched token into the JSON payload handed to the model. */
export function buildAnalysisInput(t: EnrichedToken) {
  const p = t.pool;
  return {
    token: { symbol: p.target.symbol, name: p.target.name, mint: p.target.mint },
    pool: {
      address: p.poolAddress,
      name: p.name,
      quote_asset: p.quote.symbol,
      age_hours: round(p.ageHours, 1),
      // Window over which volume/fees/volatility below are measured (e.g. "4h").
      metrics_timeframe: rules.fetcher.timeframe,
      tvl_usd: round(p.tvlUsd, 0),
      volume_window_usd: round(p.volumeWindowUsd, 0),
      volume_1h_usd: round(p.volume1hUsd, 0),
      volume_to_tvl_ratio: round(p.volumeToTvlRatio, 2),
      fee_tvl_ratio_pct: round(p.feeTvlRatioPct, 2),
      fees_window_usd: round(p.feesWindowUsd, 0),
      bin_step: p.binStep,
      base_fee_pct: p.baseFeePct,
      dynamic_fee_pct: p.dynamicFeePct,
      fee_apr_pct: round(p.feeAprPct, 2),
      launchpad: p.launchpad,
      meteora_tags: p.tags,
      meteora_holders: p.target.holders,
      meteora_verified: p.target.isVerified,
      meteora_organic_score: round(p.target.organicScore, 1),
      // Security / concentration straight from Meteora's discovery API:
      has_mint_authority: p.target.hasMintAuthority, // true = mint still enabled (risk)
      has_freeze_authority: p.target.hasFreezeAuthority, // true = freeze enabled (risk)
      top_holders_pct: round(p.target.topHoldersPct, 1),
      token_warnings: p.target.warnings ?? [],
      volatility: round(p.volatility, 2),
      price_change_pct: round(p.priceChangePct, 1),
      swap_count: p.swapCount,
      unique_traders: p.uniqueTraders,
    },
    jupiter: t.jupiter
      ? {
          listed: t.jupiter.listed,
          verified: t.jupiter.verified,
          price_usd: round(t.jupiter.priceUsd, 8),
          liquidity_usd: round(t.jupiter.liquidityUsd, 0),
          holders: t.jupiter.holders,
          organic_score: round(t.jupiter.organicScore, 1),
          organic_score_label: t.jupiter.organicScoreLabel,
          market_cap_usd: round(t.jupiter.marketCapUsd, 0),
          audit: t.jupiter.audit,
          slippage_pct: round(t.jupiter.slippagePct, 3),
          slippage_probe_usd: t.jupiter.slippageProbeUsd,
          route_hops: t.jupiter.routeHops,
        }
      : "unavailable",
    okx: t.okx
      ? {
          price_usd: round(t.okx.priceUsd, 8),
          liquidity_usd: round(t.okx.liquidityUsd, 0),
          holders: t.okx.holders,
          market_cap_usd: round(t.okx.marketCapUsd, 0),
          risk_level: t.okx.riskLevel,
          bundle_pct: t.okx.bundlePct,
          sniper_pct: t.okx.sniperPct,
          dev_holding_pct: t.okx.devHoldingPct,
          top10_holders_pct: t.okx.top10Pct,
          lp_burned_pct: t.okx.lpBurnedPct,
          is_honeypot: t.okx.isHoneypot,
          okx_tags: t.okx.tags,
        }
      : "unavailable",
    gmgn: t.gmgn
      ? {
          listed: t.gmgn.listed,
          price_usd: round(t.gmgn.priceUsd, 8),
          liquidity_usd: round(t.gmgn.liquidityUsd, 0),
          holders: t.gmgn.holders,
          market_cap_usd: round(t.gmgn.marketCapUsd, 0),
          ath_price_usd: round(t.gmgn.athPriceUsd, 8),
          top10_holders_pct: round(t.gmgn.top10Pct, 1),
          creator_hold_pct: round(t.gmgn.creatorHoldPct, 2),
          creator_token_status: t.gmgn.creatorTokenStatus, // "hold" | "sell"
          creator_prev_launches: t.gmgn.creatorLaunchCount, // high = serial launcher (risk)
          cto_flag: t.gmgn.ctoFlag, // community takeover (original dev left)
          smart_money_wallets: t.gmgn.smartMoneyWallets, // higher = more smart-money interest
          kol_wallets: t.gmgn.kolWallets,
          sniper_wallets: t.gmgn.sniperWallets,
          bundler_wallets: t.gmgn.bundlerWallets,
          fresh_wallet_pct: round(t.gmgn.freshWalletPct, 1),
          rat_trader_pct: round(t.gmgn.ratTraderPct, 1),
          bundler_trader_pct: round(t.gmgn.bundlerTraderPct, 1),
          launchpad: t.gmgn.launchpad,
          launchpad_progress: round(t.gmgn.launchpadProgress, 2), // bonding-curve fill 0-1
          exchange: t.gmgn.exchange,
          has_twitter: t.gmgn.hasTwitter,
          has_website: t.gmgn.hasWebsite,
        }
      : "unavailable",
    cross_dex_price_diff_pct: round(t.priceDiffPct, 2),
    enrichment_warnings: t.enrichmentWarnings,
  };
}

const SYSTEM_PROMPT = `You are a rigorous crypto analyst screening brand-new Solana liquidity pools on Meteora DLMM.
You perform READ-ONLY risk/quality analysis and scoring. You never give trading, execution, or financial advice, and you do not decide to buy or sell — you only assess the token's quality and risk from the provided data.

Weigh these signals:
- Liquidity depth: TVL, Jupiter cross-DEX liquidity, slippage on the probe swap, and route hops. Thin liquidity / high slippage is a strong negative.
- Trading activity: volume over the pool's metrics_timeframe window and volume/TVL ratio. Extremely high ratios on tiny TVL can indicate wash trading.
- Holder distribution: holder count and concentration (top-holders %, dev %, bundle %, sniper %). High concentration is a red flag.
- Contract safety: mint & freeze authority disabled (good), honeypot flag, LP burned %, OKX risk level.
- Smart-money & insider signals (GMGN): smart-money / KOL wallet counts holding the token are a positive interest signal; high sniper/bundler/rat-trader/fresh-wallet shares, a "sell" creator status, a high serial-launch count, or a community-takeover (cto) flag are negatives.
- Legitimacy: Jupiter listing/verification, Jupiter organic score, launchpad, and presence of real socials (GMGN has_twitter/has_website).
- Cross-DEX price consistency: a large Jupiter vs OKX price gap suggests a manipulated or desynced pool.
- Pool age: newer pools are riskier; factor recency into confidence.
Treat "unavailable" enrichment as unknown (neither good nor bad); do not penalize a token solely because a data provider was down.

Output ONLY a single valid JSON object, no markdown, no code fences, no commentary. Schema:
{
  "score": <integer 0-100, overall quality/opportunity minus risk>,
  "verdict": "promising" | "risky" | "avoid",
  "reasoning": "<2-3 sentence justification>",
  "red_flags": ["<short phrase>", ...],
  "green_flags": ["<short phrase>", ...]
}`;

export function buildMessages(t: EnrichedToken): { system: string; user: string } {
  const input = buildAnalysisInput(t);
  const user = `Analyze this Meteora DLMM pool candidate and return the JSON verdict.\n\nDATA:\n${JSON.stringify(
    input,
    null,
    2,
  )}`;
  return { system: SYSTEM_PROMPT, user };
}
