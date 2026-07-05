/**
 * Jupiter enrichment.
 *
 * Two data points per token:
 *   1. Token info  — GET https://datapi.jup.ag/v1/assets/search?query=<mint>
 *      Returns price, cross-DEX liquidity, holder count, organic score,
 *      verification, and an on-chain audit (mint/freeze authority, top-holder
 *      concentration). Presence here is the "listed on Jupiter" legitimacy signal.
 *   2. Slippage    — GET https://api.jup.ag/swap/v1/quote  (USDC -> token, $probe)
 *      priceImpactPct = estimated slippage; routePlan length = liquidity depth.
 *
 * "Not listed" (HTTP 200 with no match) is a real signal and returns an object
 * with listed=false. A transport failure (provider down) returns null so the
 * rule stage skips Jupiter-dependent checks instead of wrongly rejecting.
 */
import { z } from "zod";
import { fetchJson, HttpError } from "../util/http.js";
import { createLogger } from "../util/logger.js";
import { env } from "../config/env.js";
import type { JupiterEnrichment } from "../types.js";

const log = createLogger("jupiter");

const DATAPI = "https://datapi.jup.ag/v1";
const SWAP_API = "https://api.jup.ag/swap/v1";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;

const AuditSchema = z
  .object({
    mintAuthorityDisabled: z.boolean().nullable().optional(),
    freezeAuthorityDisabled: z.boolean().nullable().optional(),
    topHoldersPercentage: z.number().nullable().optional(),
    devBalancePercentage: z.number().nullable().optional(),
  })
  .passthrough();

const AssetSchema = z
  .object({
    id: z.string(),
    symbol: z.string().optional(),
    usdPrice: z.number().nullable().optional(),
    liquidity: z.number().nullable().optional(),
    holderCount: z.number().nullable().optional(),
    organicScore: z.number().nullable().optional(),
    organicScoreLabel: z.string().nullable().optional(),
    isVerified: z.boolean().optional().default(false),
    mcap: z.number().nullable().optional(),
    audit: AuditSchema.nullable().optional(),
  })
  .passthrough();

const AssetsResponse = z.array(AssetSchema);

const QuoteSchema = z
  .object({
    priceImpactPct: z.union([z.string(), z.number()]).nullable().optional(),
    routePlan: z.array(z.unknown()).optional().default([]),
    outAmount: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

function jupiterHeaders(): Record<string, string> {
  return env.jupiter.apiKey ? { "x-api-key": env.jupiter.apiKey } : {};
}

const toNum = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** Fetch the token record. Returns the matched asset, null if unlisted, or throws if down. */
async function fetchAsset(mint: string) {
  const url = `${DATAPI}/assets/search?query=${encodeURIComponent(mint)}`;
  const json = await fetchJson(url, { label: `jupiter assets/search ${mint.slice(0, 6)}`, headers: jupiterHeaders() });
  const parsed = AssetsResponse.safeParse(json);
  if (!parsed.success) throw new Error(`Jupiter assets/search shape changed: ${parsed.error.message}`);
  return parsed.data.find((t) => t.id === mint) ?? null;
}

/** Probe slippage for a $probeUsd swap of USDC -> token. Returns {slippagePct, routeHops} or nulls. */
async function fetchSlippage(mint: string, probeUsd: number): Promise<{ slippagePct: number | null; routeHops: number | null }> {
  const amount = Math.round(probeUsd * 10 ** USDC_DECIMALS);
  // High slippageBps just widens the min-out threshold; we only read priceImpactPct.
  const url =
    `${SWAP_API}/quote?inputMint=${USDC_MINT}&outputMint=${mint}` +
    `&amount=${amount}&slippageBps=1500&restrictIntermediateTokens=true`;
  try {
    const json = await fetchJson(url, { label: `jupiter quote ${mint.slice(0, 6)}`, headers: jupiterHeaders(), retries: 2 });
    const parsed = QuoteSchema.safeParse(json);
    if (!parsed.success) return { slippagePct: null, routeHops: null };
    const impact = toNum(parsed.data.priceImpactPct ?? null);
    return {
      slippagePct: impact === null ? null : impact * 100, // fraction -> percent
      routeHops: parsed.data.routePlan.length || null,
    };
  } catch (err) {
    // No route / thin liquidity is common for junk tokens — treat as "unknown".
    const status = err instanceof HttpError ? ` (HTTP ${err.status})` : "";
    log.debug(`no swap route for ${mint.slice(0, 6)}${status}`);
    return { slippagePct: null, routeHops: null };
  }
}

/**
 * Enrich a token via Jupiter. Returns null only when the provider is
 * unreachable (so the caller can skip Jupiter rules); an unlisted token yields
 * an object with listed=false.
 */
export async function enrichWithJupiter(mint: string, probeUsd: number): Promise<JupiterEnrichment | null> {
  let asset;
  try {
    asset = await fetchAsset(mint);
  } catch (err) {
    log.warn(`token lookup failed for ${mint.slice(0, 6)} — skipping Jupiter enrichment`, err);
    return null;
  }

  if (!asset) {
    return {
      listed: false,
      verified: false,
      priceUsd: null,
      liquidityUsd: null,
      holders: null,
      organicScore: null,
      organicScoreLabel: null,
      marketCapUsd: null,
      audit: null,
      slippagePct: null,
      slippageProbeUsd: probeUsd,
      routeHops: null,
    };
  }

  const { slippagePct, routeHops } = await fetchSlippage(mint, probeUsd);

  return {
    listed: true,
    verified: Boolean(asset.isVerified),
    priceUsd: toNum(asset.usdPrice),
    liquidityUsd: toNum(asset.liquidity),
    holders: asset.holderCount ?? null,
    organicScore: toNum(asset.organicScore),
    organicScoreLabel: asset.organicScoreLabel ?? null,
    marketCapUsd: toNum(asset.mcap),
    audit: asset.audit
      ? {
          mintAuthorityDisabled: asset.audit.mintAuthorityDisabled ?? null,
          freezeAuthorityDisabled: asset.audit.freezeAuthorityDisabled ?? null,
          topHoldersPct: toNum(asset.audit.topHoldersPercentage),
          devBalancePct: toNum(asset.audit.devBalancePercentage),
        }
      : null,
    slippagePct,
    slippageProbeUsd: probeUsd,
    routeHops,
  };
}
