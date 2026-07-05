/**
 * Meteora DLMM data fetcher — Pool Discovery API.
 *
 * Source: https://pool-discovery-api.datapi.meteora.ag/pools
 * Unlike the plain `/pools` list, this endpoint supports **server-side
 * filtering** via a `filter_by` DSL (joined by `&&`), so the TVL / volume /
 * pool-age / safety gates are applied by Meteora before we ever see the data —
 * we get back a small set of already-relevant, newest-first pools instead of
 * paging through thousands. It also returns ~60 fields per pool, including
 * token warnings, mint/freeze-authority flags, and holder concentration.
 *
 * Each pool is validated individually with zod: a malformed pool is skipped,
 * but a changed envelope shape throws loudly (catch API drift, don't read
 * `undefined`).
 */
import { z } from "zod";
import { fetchJson } from "../util/http.js";
import { createLogger } from "../util/logger.js";
import { rules } from "../config/rules.js";
import type { MeteoraPool, TokenSide } from "../types.js";

const log = createLogger("meteora");

const BASE_URL = "https://pool-discovery-api.datapi.meteora.ag";

const WarningSchema = z.union([z.string(), z.object({ type: z.string() }).passthrough()]);

const TokenSchema = z
  .object({
    address: z.string().min(32),
    name: z.string().default(""),
    symbol: z.string().default(""),
    decimals: z.number().int().nonnegative().default(0),
    is_verified: z.boolean().default(false),
    holders: z.number().nullable().default(null),
    price: z.number().nullable().default(null),
    market_cap: z.number().nullable().default(null),
    organic_score: z.number().nullable().default(null),
    organic_score_label: z.string().nullable().default(null),
    has_mint_authority: z.boolean().nullable().default(null),
    has_freeze_authority: z.boolean().nullable().default(null),
    top_holders_pct: z.number().nullable().default(null),
    dev: z.string().nullable().default(null),
    tags: z.array(z.any()).default([]),
    warnings: z.array(WarningSchema).default([]),
  })
  .passthrough();

const PoolSchema = z
  .object({
    pool_address: z.string().min(32),
    name: z.string().default(""),
    token_x: TokenSchema,
    token_y: TokenSchema,
    pool_created_at: z.number(), // unix ms
    dlmm_params: z.object({ bin_step: z.number().nullable().optional() }).passthrough().nullable().optional(),
    fee_pct: z.number().nullable().optional(),
    dynamic_fee_pct: z.number().nullable().optional(),
    fee: z.number().nullable().optional(), // fee in the selected timeframe window
    fee_tvl_ratio: z.number().nullable().optional(), // fee/TVL for the window, in %
    volume: z.number(), // volume in the selected timeframe window
    tvl: z.number(),
    pool_price: z.number().nullable().optional(),
    pool_price_change_pct: z.number().nullable().optional(),
    is_blacklisted: z.boolean().default(false),
    volatility: z.number().nullable().optional(),
    // NOTE: `price_trend` is a sparkline array (not a scalar); use pool_price_change_pct.
    swap_count: z.number().nullable().optional(),
    unique_traders: z.number().nullable().optional(),
  })
  .passthrough();

const ResponseSchema = z
  .object({
    total: z.number().optional(),
    data: z.array(z.unknown()),
  })
  .passthrough();

type RawPool = z.infer<typeof PoolSchema>;
type RawToken = z.infer<typeof TokenSchema>;

function toSide(t: RawToken): TokenSide {
  return {
    mint: t.address,
    symbol: t.symbol || "?",
    name: t.name || "",
    decimals: t.decimals,
    isVerified: t.is_verified,
    holders: t.holders,
    priceUsd: t.price,
    marketCapUsd: t.market_cap,
    organicScore: t.organic_score,
    organicScoreLabel: t.organic_score_label,
    hasMintAuthority: t.has_mint_authority,
    hasFreezeAuthority: t.has_freeze_authority,
    topHoldersPct: t.top_holders_pct,
    dev: t.dev,
    warnings: t.warnings.map((w) => (typeof w === "string" ? w : w.type)),
  };
}

/** Split a pair into (target, quote); null if not "one new token vs one quote asset". */
function classifyPair(raw: RawPool, quoteMints: Set<string>): { target: RawToken; quote: RawToken } | null {
  const xQuote = quoteMints.has(raw.token_x.address);
  const yQuote = quoteMints.has(raw.token_y.address);
  if (xQuote === yQuote) return null;
  return xQuote ? { target: raw.token_y, quote: raw.token_x } : { target: raw.token_x, quote: raw.token_y };
}

function mapPool(raw: RawPool, quoteMints: Set<string>): MeteoraPool | null {
  const classified = classifyPair(raw, quoteMints);
  if (!classified) return null;

  const tvl = raw.tvl;
  const volumeWindow = raw.volume ?? 0;
  const target = toSide(classified.target);

  return {
    poolAddress: raw.pool_address,
    name: raw.name || `${classified.target.symbol}-${classified.quote.symbol}`,
    target,
    quote: toSide(classified.quote),
    tvlUsd: tvl,
    volumeWindowUsd: volumeWindow,
    volume1hUsd: null, // available via a separate timeframe request if ever needed
    feesWindowUsd: raw.fee ?? null,
    ageHours: (Date.now() - raw.pool_created_at) / 3_600_000,
    createdAtMs: raw.pool_created_at,
    binStep: raw.dlmm_params?.bin_step ?? null,
    baseFeePct: raw.fee_pct ?? null,
    dynamicFeePct: raw.dynamic_fee_pct ?? null,
    feeAprPct: null, // not exposed by this endpoint; fee tier shown instead
    feeApyPct: null,
    volumeToTvlRatio: tvl > 0 ? volumeWindow / tvl : 0,
    feeTvlRatioPct: raw.fee_tvl_ratio ?? (tvl > 0 && raw.fee != null ? (raw.fee / tvl) * 100 : null),
    currentPrice: raw.pool_price ?? null,
    isBlacklisted: raw.is_blacklisted,
    tags: (classified.target.tags ?? []).map((t) => String(t)),
    launchpad: null,
    volatility: raw.volatility ?? null,
    priceChangePct: raw.pool_price_change_pct ?? null,
    swapCount: raw.swap_count ?? null,
    uniqueTraders: raw.unique_traders ?? null,
  };
}

/**
 * Build the server-side `filter_by` DSL from the stage-1 config (mirrors the
 * meridian LP-agent's discovery filter). Pushing these gates to the API means
 * we only download already-relevant pools. The safety flags are always on —
 * critically-warned and single-owner tokens are dropped by Meteora for free.
 */
function buildFilter(): string {
  const s = rules.stage1;
  const now = Date.now();
  const parts: (string | null)[] = [
    "pool_type=dlmm",
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    `tvl>=${Math.floor(s.minTvlUsd)}`,
    s.maxTvlUsd > 0 ? `tvl<=${Math.floor(s.maxTvlUsd)}` : null,
    `volume>=${Math.floor(s.minVolumeUsd)}`,
    s.minFeeTvlRatioPct > 0 ? `fee_active_tvl_ratio>=${s.minFeeTvlRatioPct}` : null,
    s.minMcapUsd > 0 ? `base_token_market_cap>=${Math.floor(s.minMcapUsd)}` : null,
    s.maxMcapUsd > 0 ? `base_token_market_cap<=${Math.floor(s.maxMcapUsd)}` : null,
    s.minHolders > 0 ? `base_token_holders>=${s.minHolders}` : null,
    s.minOrganicScore > 0 ? `base_token_organic_score>=${s.minOrganicScore}` : null,
    s.minQuoteOrganicScore > 0 ? `quote_token_organic_score>=${s.minQuoteOrganicScore}` : null,
    s.minBinStep > 0 ? `dlmm_bin_step>=${s.minBinStep}` : null,
    s.maxBinStep > 0 ? `dlmm_bin_step<=${s.maxBinStep}` : null,
    // Token-age band keys off the *base token* creation time.
    s.minTokenAgeHours != null ? `base_token_created_at<=${now - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${now - s.maxTokenAgeHours * 3_600_000}` : null,
    s.maxPoolAgeHours > 0 ? `pool_created_at>=${now - s.maxPoolAgeHours * 3_600_000}` : null,
  ];
  return parts.filter((p): p is string => p !== null).join("&&");
}

export interface FetchOptions {
  pageSize?: number;
}

/**
 * Fetch and normalize active DLMM pools (server-side filtered, ranked by the
 * configured `category` — trending/top/new). Returns pools shaped as "one
 * target token vs one quote asset".
 */
export async function fetchRecentPools(opts: FetchOptions = {}): Promise<MeteoraPool[]> {
  const pageSize = opts.pageSize ?? rules.fetcher.pageSize;
  const quoteMints = new Set(rules.fetcher.quoteMints);
  const filter = buildFilter();

  const url =
    `${BASE_URL}/pools?page_size=${pageSize}` +
    `&filter_by=${encodeURIComponent(filter)}` +
    `&timeframe=${rules.fetcher.timeframe}` +
    `&category=${rules.fetcher.category}` +
    (rules.fetcher.sortBy ? `&sort_by=${encodeURIComponent(rules.fetcher.sortBy)}` : "");

  const json = await fetchJson(url, { label: "meteora pool-discovery", timeoutMs: 25_000 });
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Meteora pool-discovery envelope failed validation: ${parsed.error.message}`);
  }

  const items = parsed.data.data;
  const total = parsed.data.total ?? items.length;
  const out: MeteoraPool[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  let skippedShape = 0;

  for (const item of items) {
    const p = PoolSchema.safeParse(item);
    if (!p.success) {
      invalid++;
      log.debug(`skipping malformed pool: ${p.error.issues[0]?.message ?? "unknown"}`);
      continue;
    }
    const mapped = mapPool(p.data, quoteMints);
    if (!mapped) {
      skippedShape++;
      continue;
    }
    if (seen.has(mapped.poolAddress)) continue;
    seen.add(mapped.poolAddress);
    out.push(mapped);
  }

  if (invalid > 0 && invalid === items.length) {
    throw new Error(`All ${items.length} pool-discovery items failed validation — API shape likely changed`);
  }
  if (total > pageSize) {
    log.warn(`pool-discovery matched ${total} pools but page_size=${pageSize}; raise fetcher.pageSize to see more`);
  }

  log.info(
    `fetched ${out.length} candidate pools (server-filtered ${items.length} returned / ${total} matched, ` +
      `${skippedShape} not target/quote, ${invalid} malformed)`,
  );
  return out;
}
