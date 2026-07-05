/**
 * GMGN OpenAPI enrichment — GET https://openapi.gmgn.ai/v1/token/info.
 *
 * Auth for read/query routes ("exist auth", no private key): an `X-APIKEY`
 * header plus `timestamp` (Unix seconds, server tolerance ±5s) and a fresh
 * `client_id` UUID (replay-protected within 7s) as query params. Apply for a
 * key at https://gmgn.ai/ai and set GMGN_API_KEY. This is exactly what the
 * official gmgn-cli does under the hood — the OpenAPI host is meant for direct
 * HTTP (unlike the gmgn.ai *website*, which needs a login).
 *
 * Best-effort, same contract as the other providers: returns null when GMGN is
 * disabled (no key) or unreachable, so the caller skips GMGN-dependent signals
 * instead of failing the cycle. Success envelope is `{ code: 0, data: {...} }`.
 *
 * Rate limit: leaky bucket (rate=20, capacity=20), weight 1 for /v1/token/info.
 * We pace requests and never auto-retry a 429 — GMGN extends the ban by 5s on
 * each request sent during a cooldown.
 *
 * NOTE: the OpenAPI only answers over IPv4; a 401/403 with a valid key usually
 * means outbound traffic is going via IPv6.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { fetchJson, HttpError } from "../util/http.js";
import { createLogger } from "../util/logger.js";
import { env } from "../config/env.js";
import type { GmgnEnrichment } from "../types.js";

const log = createLogger("gmgn");

const BASE = "https://openapi.gmgn.ai";
const CHAIN_SOLANA = "sol";
const GMGN_MIN_INTERVAL_MS = 250; // stay comfortably under the leaky-bucket limit

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Global pacing gate — single-threaded JS makes slot reservation atomic, so even
// concurrent callers queue GMGN_MIN_INTERVAL_MS apart (mirrors okx.ts).
let gmgnNextSlot = 0;
async function pace(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, gmgnNextSlot);
  gmgnNextSlot = start + GMGN_MIN_INTERVAL_MS;
  if (start > now) await sleep(start - now);
}

/** Response envelope shared by all OpenAPI routes. */
const Envelope = z
  .object({ code: z.union([z.number(), z.string()]), data: z.unknown().optional() })
  .passthrough();

/** Tolerant shape of the fields we read from /v1/token/info's `data`. */
const TokenInfo = z
  .object({
    price: z
      .object({ price: z.union([z.string(), z.number()]).nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    liquidity: z.union([z.string(), z.number()]).nullable().optional(),
    holder_count: z.union([z.string(), z.number()]).nullable().optional(),
    circulating_supply: z.union([z.string(), z.number()]).nullable().optional(),
    ath_price: z.union([z.string(), z.number()]).nullable().optional(),
    launchpad: z.string().nullable().optional(),
    launchpad_progress: z.union([z.string(), z.number()]).nullable().optional(),
    pool: z.object({ exchange: z.string().nullable().optional() }).passthrough().nullable().optional(),
    dev: z
      .object({
        creator_token_status: z.string().nullable().optional(),
        creator_open_count: z.union([z.string(), z.number()]).nullable().optional(),
        cto_flag: z.union([z.number(), z.boolean()]).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    stat: z
      .object({
        top_10_holder_rate: z.union([z.string(), z.number()]).nullable().optional(),
        creator_hold_rate: z.union([z.string(), z.number()]).nullable().optional(),
        fresh_wallet_rate: z.union([z.string(), z.number()]).nullable().optional(),
        top_rat_trader_percentage: z.union([z.string(), z.number()]).nullable().optional(),
        top_bundler_trader_percentage: z.union([z.string(), z.number()]).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    wallet_tags_stat: z
      .object({
        smart_wallets: z.union([z.string(), z.number()]).nullable().optional(),
        renowned_wallets: z.union([z.string(), z.number()]).nullable().optional(),
        sniper_wallets: z.union([z.string(), z.number()]).nullable().optional(),
        bundler_wallets: z.union([z.string(), z.number()]).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    link: z
      .object({
        twitter_username: z.string().nullable().optional(),
        website: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

/** GMGN reports concentrations as 0–1 ratios; scale to percent to match Jupiter/OKX. */
const toPct = (v: unknown): number | null => {
  const n = toNum(v);
  return n === null ? null : n * 100;
};

const toBool = (v: unknown): boolean => v === true || v === 1 || v === "1";

/** GET /v1/token/info for `mint`. Returns parsed token-info data, or null. */
async function fetchTokenInfo(mint: string): Promise<z.infer<typeof TokenInfo> | null> {
  const url =
    `${BASE}/v1/token/info?chain=${CHAIN_SOLANA}&address=${encodeURIComponent(mint)}` +
    `&timestamp=${Math.floor(Date.now() / 1000)}&client_id=${crypto.randomUUID()}`;

  await pace();
  // retries:1 → single attempt: never re-send on 429 (GMGN extends the ban if we do).
  const json = await fetchJson(url, {
    label: `gmgn token/info ${mint.slice(0, 6)}`,
    headers: { "X-APIKEY": env.gmgn.apiKey! },
    retries: 1,
  });

  const env0 = Envelope.safeParse(json);
  if (!env0.success) throw new Error(`GMGN envelope shape changed: ${env0.error.message}`);
  if (String(env0.data.code) !== "0") {
    log.debug(`token/info non-zero code ${env0.data.code} for ${mint.slice(0, 6)}`);
    return null;
  }

  const parsed = TokenInfo.safeParse(env0.data.data);
  if (!parsed.success) throw new Error(`GMGN token/info shape changed: ${parsed.error.message}`);
  return parsed.data;
}

/**
 * Enrich a token via GMGN. Returns null when GMGN is disabled (no key) or the
 * request fails — the caller then skips GMGN-dependent rules/signals.
 */
export async function enrichWithGmgn(mint: string): Promise<GmgnEnrichment | null> {
  if (!env.gmgn.enabled) return null;

  let info: z.infer<typeof TokenInfo> | null;
  try {
    info = await fetchTokenInfo(mint);
  } catch (err) {
    const status = err instanceof HttpError ? ` (HTTP ${err.status})` : "";
    log.debug(`token/info failed for ${mint.slice(0, 6)}${status}`, err);
    return null;
  }
  if (!info) return null;

  const priceUsd = toNum(info.price?.price);
  const supply = toNum(info.circulating_supply);
  const marketCapUsd = priceUsd !== null && supply !== null ? priceUsd * supply : null;

  return {
    listed: true,
    priceUsd,
    liquidityUsd: toNum(info.liquidity),
    holders: toNum(info.holder_count),
    marketCapUsd,
    top10Pct: toPct(info.stat?.top_10_holder_rate),
    athPriceUsd: toNum(info.ath_price),
    creatorHoldPct: toPct(info.stat?.creator_hold_rate),
    creatorTokenStatus: info.dev?.creator_token_status ?? null,
    creatorLaunchCount: toNum(info.dev?.creator_open_count),
    ctoFlag: toBool(info.dev?.cto_flag),
    smartMoneyWallets: toNum(info.wallet_tags_stat?.smart_wallets),
    kolWallets: toNum(info.wallet_tags_stat?.renowned_wallets),
    sniperWallets: toNum(info.wallet_tags_stat?.sniper_wallets),
    bundlerWallets: toNum(info.wallet_tags_stat?.bundler_wallets),
    freshWalletPct: toPct(info.stat?.fresh_wallet_rate),
    ratTraderPct: toPct(info.stat?.top_rat_trader_percentage),
    bundlerTraderPct: toPct(info.stat?.top_bundler_trader_percentage),
    launchpad: info.launchpad ?? null,
    launchpadProgress: toNum(info.launchpad_progress),
    exchange: info.pool?.exchange ?? null,
    hasTwitter: Boolean(info.link?.twitter_username),
    hasWebsite: Boolean(info.link?.website),
  };
}
