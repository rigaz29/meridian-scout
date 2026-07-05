/**
 * Shared domain types that flow through the screening pipeline:
 *   MeteoraPool  → (enrich)  EnrichedToken  → (LLM)  ScreenedCandidate
 */

/** One side of a DLMM pair. */
export interface TokenSide {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  isVerified: boolean;
  holders: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  // Extra fields available from the Meteora pool-discovery API (target side).
  organicScore?: number | null;
  organicScoreLabel?: string | null;
  hasMintAuthority?: boolean | null;
  hasFreezeAuthority?: boolean | null;
  topHoldersPct?: number | null;
  dev?: string | null;
  /** Meteora warning types on the token, e.g. ["NOT_VERIFIED", "NEW_LISTING"]. */
  warnings?: string[];
}

/** A Meteora DLMM pool normalized into the fields the screener reasons about. */
export interface MeteoraPool {
  poolAddress: string;
  name: string;
  /** The token being screened (the non-quote side of the pair). */
  target: TokenSide;
  /** The quote asset side (SOL / USDC / USDT). */
  quote: TokenSide;
  tvlUsd: number;
  /** Trade volume (USD) over the fetcher `timeframe` window (e.g. 4h). */
  volumeWindowUsd: number;
  volume1hUsd: number | null;
  /** Fees earned (USD) over the fetcher `timeframe` window. */
  feesWindowUsd: number | null;
  /** Pool age in hours since creation. */
  ageHours: number;
  createdAtMs: number;
  binStep: number | null;
  baseFeePct: number | null;
  dynamicFeePct: number | null;
  feeAprPct: number | null;
  feeApyPct: number | null;
  /** Window volume divided by TVL — a rough "activity" ratio. */
  volumeToTvlRatio: number;
  /** Fee / TVL over the window, in percent — the core DLMM pool-quality metric. */
  feeTvlRatioPct: number | null;
  currentPrice: number | null;
  isBlacklisted: boolean;
  tags: string[];
  launchpad: string | null;
  // Extra pool-level signals from the pool-discovery API.
  volatility?: number | null;
  priceChangePct?: number | null;
  swapCount?: number | null;
  uniqueTraders?: number | null;
}

/** Jupiter enrichment for the target token (datapi assets/search + swap quote). */
export interface JupiterEnrichment {
  listed: boolean;
  verified: boolean;
  priceUsd: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  organicScore: number | null;
  organicScoreLabel: string | null;
  marketCapUsd: number | null;
  audit: {
    mintAuthorityDisabled: boolean | null;
    freezeAuthorityDisabled: boolean | null;
    topHoldersPct: number | null;
    devBalancePct: number | null;
  } | null;
  /** Price impact (%) for a `slippageProbeUsd` swap from USDC into the token. */
  slippagePct: number | null;
  slippageProbeUsd: number | null;
  /** Number of route hops for the probe swap (proxy for liquidity depth). */
  routeHops: number | null;
}

/** OKX DEX enrichment for the target token (requires API keys). */
export interface OkxEnrichment {
  priceUsd: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  marketCapUsd: number | null;
  riskLevel: number | null;
  bundlePct: number | null;
  sniperPct: number | null;
  devHoldingPct: number | null;
  top10Pct: number | null;
  lpBurnedPct: number | null;
  isHoneypot: boolean;
  tags: string[];
}

/**
 * GMGN OpenAPI enrichment for the target token (GET /v1/token/info).
 *
 * Adds signals the other providers don't surface: smart-money / KOL wallet
 * exposure, creator/dev launch history, sniper & bundler wallet counts, and
 * launchpad bonding-curve progress. All `*Pct` fields are GMGN's 0–1 ratios
 * rescaled to percent for consistency with the Jupiter/OKX fields.
 */
export interface GmgnEnrichment {
  /** GMGN returned a record for this mint (legitimacy signal in itself). */
  listed: boolean;
  priceUsd: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  marketCapUsd: number | null;
  top10Pct: number | null;
  /** All-time-high price (USD) — used for the ATH-distance gate. */
  athPriceUsd: number | null;
  creatorHoldPct: number | null;
  /** "hold" = creator still holding, "sell" = creator exited. */
  creatorTokenStatus: string | null;
  /** How many tokens this creator has launched before (serial-launcher signal). */
  creatorLaunchCount: number | null;
  /** Community-takeover flag: original dev abandoned the token. */
  ctoFlag: boolean;
  /** Number of tagged smart-money wallets currently holding. */
  smartMoneyWallets: number | null;
  /** Number of tagged KOL / renowned wallets currently holding. */
  kolWallets: number | null;
  sniperWallets: number | null;
  bundlerWallets: number | null;
  freshWalletPct: number | null;
  ratTraderPct: number | null;
  bundlerTraderPct: number | null;
  launchpad: string | null;
  /** Bonding-curve progress 0–1 (null once graduated / not a launchpad token). */
  launchpadProgress: number | null;
  /** Main-pool DEX name, e.g. "meteora_dlmm", "raydium". */
  exchange: string | null;
  hasTwitter: boolean;
  hasWebsite: boolean;
}

/** A pool enriched with cross-DEX data, ready for rule stage 2 + the LLM. */
export interface EnrichedToken {
  pool: MeteoraPool;
  jupiter: JupiterEnrichment | null;
  okx: OkxEnrichment | null;
  gmgn: GmgnEnrichment | null;
  /** |Jupiter price − OKX price| / mid, in %. Null if either price missing. */
  priceDiffPct: number | null;
  /** Notes about enrichment providers that failed/were skipped. */
  enrichmentWarnings: string[];
}

/** Structured verdict returned by the LLM deep-dive. */
export interface LlmVerdict {
  score: number;
  verdict: "promising" | "risky" | "avoid";
  reasoning: string;
  red_flags: string[];
  green_flags: string[];
}

/** Final object passed to the notifier. */
export interface ScreenedCandidate extends EnrichedToken {
  verdict: LlmVerdict;
  /** Which LLM provider produced the verdict ("openrouter" | "deepseek"). */
  llmProvider: string;
}

/** Result of applying a rule set to a value. */
export interface FilterResult {
  passed: boolean;
  /** Human-readable reasons a pool was rejected (empty when passed). */
  reasons: string[];
  /** Rules that were skipped because their input data was unavailable. */
  skipped: string[];
}
