/**
 * OKX DEX enrichment — cross-DEX price/liquidity check + token security data.
 *
 * The OKX market endpoints require authenticated requests (the previously
 * keyless "agent-cli" path now returns a payment challenge). Auth is HMAC-SHA256
 * over `timestamp + method + path + body`, per the OKX Web3 API spec. Without
 * keys this module is a no-op (returns null) — enrichment is best-effort.
 *
 * Endpoints (chainIndex 501 = Solana):
 *   POST /api/v6/dex/market/price-info                 → price, holders, mcap, liquidity
 *   GET  /api/v6/dex/market/token/advanced-info        → risk level, bundle/sniper/dev %, honeypot
 *
 * Signing + pacing mirror the reference implementation in the meridian project.
 */
import crypto from "node:crypto";
import { createLogger } from "../util/logger.js";
import { env } from "../config/env.js";
import type { OkxEnrichment } from "../types.js";

const log = createLogger("okx");

const BASE = "https://web3.okx.com";
const CHAIN_SOLANA = "501";
const OKX_MIN_INTERVAL_MS = 400; // OKX caps ~3 req/s; serialize every request
const OKX_RETRYABLE_CODES = new Set(["50011", "50013", "50026"]);
const REQUEST_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Global pacing gate — single-threaded JS makes slot reservation atomic, so even
// concurrent callers queue OKX_MIN_INTERVAL_MS apart.
let okxNextSlot = 0;
async function pace(): Promise<void> {
  const now = Date.now();
  const start = Math.max(now, okxNextSlot);
  okxNextSlot = start + OKX_MIN_INTERVAL_MS;
  if (start > now) await sleep(start - now);
}

function authHeaders(method: string, path: string, body: string): Record<string, string> {
  const timestamp = new Date().toISOString();
  const prehash = `${timestamp}${method.toUpperCase()}${path}${body}`;
  const sign = crypto.createHmac("sha256", env.okx.secretKey!).update(prehash).digest("base64");
  const headers: Record<string, string> = {
    "OK-ACCESS-KEY": env.okx.apiKey!,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-PASSPHRASE": env.okx.passphrase!,
    "OK-ACCESS-TIMESTAMP": timestamp,
  };
  if (env.okx.projectId) headers["OK-ACCESS-PROJECT"] = env.okx.projectId;
  return headers;
}

async function okxRequest(method: "GET" | "POST", path: string, body: unknown = null, retries = 3): Promise<unknown> {
  const bodyText = body == null ? "" : JSON.stringify(body);
  for (let attempt = 0; attempt < retries; attempt++) {
    const last = attempt === retries - 1;
    const headers = {
      ...authHeaders(method, path, bodyText),
      ...(body != null ? { "Content-Type": "application/json" } : {}),
    };

    await pace();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        ...(body != null ? { body: bodyText } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (last) throw err;
      await sleep(400 * (attempt + 1) ** 2);
      continue;
    }
    clearTimeout(timer);

    if ((res.status === 429 || res.status >= 500) && !last) {
      const ra = Number.parseInt(res.headers.get("retry-after") || "", 10);
      await sleep(Number.isFinite(ra) ? ra * 1000 : 400 * (attempt + 1) ** 2);
      continue;
    }
    if (!res.ok) throw new Error(`OKX HTTP ${res.status}: ${path}`);

    const json = (await res.json()) as { code?: string | number; msg?: string; data?: unknown };
    if (json.code !== "0" && json.code !== 0) {
      if (OKX_RETRYABLE_CODES.has(String(json.code)) && !last) {
        await sleep(400 * (attempt + 1) ** 2);
        continue;
      }
      throw new Error(`OKX error ${json.code}: ${json.msg || "unknown"}`);
    }
    return json.data;
  }
  throw new Error(`OKX request failed after ${retries} attempts: ${path}`);
}

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

const firstOf = (data: unknown): Record<string, unknown> | null =>
  Array.isArray(data) ? ((data[0] as Record<string, unknown>) ?? null) : ((data as Record<string, unknown>) ?? null);

async function getPriceInfo(mint: string) {
  const data = await okxRequest("POST", "/api/v6/dex/market/price-info", [
    { chainIndex: CHAIN_SOLANA, tokenContractAddress: mint },
  ]);
  const d = firstOf(data);
  if (!d) return null;
  return {
    priceUsd: toNum(d.price),
    holders: toNum(d.holders),
    marketCapUsd: toNum(d.marketCap),
    liquidityUsd: toNum(d.liquidity),
  };
}

async function getAdvancedInfo(mint: string) {
  const data = await okxRequest(
    "GET",
    `/api/v6/dex/market/token/advanced-info?chainIndex=${CHAIN_SOLANA}&tokenContractAddress=${mint}`,
  );
  const d = firstOf(data);
  if (!d) return null;
  const tags = Array.isArray(d.tokenTags) ? (d.tokenTags as unknown[]).map(String) : [];
  return {
    riskLevel: toNum(d.riskControlLevel),
    bundlePct: toNum(d.bundleHoldingPercent),
    sniperPct: toNum(d.sniperHoldingPercent),
    devHoldingPct: toNum(d.devHoldingPercent),
    top10Pct: toNum(d.top10HoldPercent),
    lpBurnedPct: toNum(d.lpBurnedPercent),
    isHoneypot: tags.includes("honeypot"),
    tags,
  };
}

/**
 * Enrich a token via OKX. Returns null when OKX is disabled (no keys) or both
 * sub-requests fail — the caller then skips OKX-dependent rules.
 */
export async function enrichWithOkx(mint: string): Promise<OkxEnrichment | null> {
  if (!env.okx.enabled) return null;

  const [priceRes, advRes] = await Promise.allSettled([getPriceInfo(mint), getAdvancedInfo(mint)]);
  const price = priceRes.status === "fulfilled" ? priceRes.value : null;
  const adv = advRes.status === "fulfilled" ? advRes.value : null;

  if (priceRes.status === "rejected") log.debug(`price-info failed for ${mint.slice(0, 6)}`, priceRes.reason);
  if (advRes.status === "rejected") log.debug(`advanced-info failed for ${mint.slice(0, 6)}`, advRes.reason);

  if (!price && !adv) return null; // provider fully unavailable for this token

  return {
    priceUsd: price?.priceUsd ?? null,
    liquidityUsd: price?.liquidityUsd ?? null,
    holders: price?.holders ?? null,
    marketCapUsd: price?.marketCapUsd ?? null,
    riskLevel: adv?.riskLevel ?? null,
    bundlePct: adv?.bundlePct ?? null,
    sniperPct: adv?.sniperPct ?? null,
    devHoldingPct: adv?.devHoldingPct ?? null,
    top10Pct: adv?.top10Pct ?? null,
    lpBurnedPct: adv?.lpBurnedPct ?? null,
    isHoneypot: adv?.isHoneypot ?? false,
    tags: adv?.tags ?? [],
  };
}
