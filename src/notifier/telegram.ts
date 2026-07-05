/**
 * Telegram notifier (grammy). Sends one formatted message per screened
 * candidate. We only use the HTTP send API (no long-polling), so there's no
 * bot loop to manage. Per-cycle flood limits are enforced by the pipeline.
 */
import { Bot } from "grammy";
import { createLogger } from "../util/logger.js";
import { env } from "../config/env.js";
import { rules as defaultRules, type Rules } from "../config/rules.js";
import type { ScreenedCandidate } from "../types.js";

const log = createLogger("telegram");

let botCache: Bot | null = null;
function getBot(): Bot {
  if (!env.telegram.botToken) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  if (!botCache) botCache = new Bot(env.telegram.botToken);
  return botCache;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPrice(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n >= 1) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(2)}`;
}

/** Render an authority flag: true = still active (risk), false = revoked (good). */
function authFlag(active: boolean | null | undefined): string {
  if (active === true) return "⚠️active";
  if (active === false) return "✓revoked";
  return "?";
}

/** Compact security line from Meteora discovery fields; null if nothing to show. */
function securityLine(c: ScreenedCandidate): string | null {
  const t = c.pool.target;
  if (t.hasMintAuthority == null && t.hasFreezeAuthority == null && t.topHoldersPct == null) return null;
  const parts = [`<b>Mint:</b> ${authFlag(t.hasMintAuthority)}`, `<b>Freeze:</b> ${authFlag(t.hasFreezeAuthority)}`];
  if (t.topHoldersPct != null) parts.push(`<b>Top holders:</b> ${t.topHoldersPct.toFixed(1)}%`);
  return `🔐 ${parts.join(" · ")}`;
}

const VERDICT_META: Record<string, { emoji: string; label: string }> = {
  promising: { emoji: "🟢", label: "Promising" },
  risky: { emoji: "🟡", label: "Risky" },
  avoid: { emoji: "🔴", label: "Avoid" },
};

export function formatCandidate(c: ScreenedCandidate, rules: Rules = defaultRules): string {
  const p = c.pool;
  const v = c.verdict;
  const meta = VERDICT_META[v.verdict] ?? { emoji: "⚪️", label: v.verdict };

  const poolUrl = `${rules.notifier.meteoraPoolBaseUrl}/${p.poolAddress}`;
  const dexUrl = `${rules.notifier.dexscreenerBaseUrl}/${p.poolAddress}`;

  const price = c.jupiter?.priceUsd ?? p.target.priceUsd;
  const priceDiff = c.priceDiffPct === null ? "OKX n/a" : `${c.priceDiffPct.toFixed(1)}%`;
  const holders = c.jupiter?.holders ?? p.target.holders;
  const organic = c.jupiter?.organicScoreLabel
    ? `${c.jupiter.organicScoreLabel}${c.jupiter.organicScore !== null ? ` (${c.jupiter.organicScore.toFixed(0)})` : ""}`
    : "—";
  const feeTier = p.baseFeePct !== null ? `${p.baseFeePct}%${p.binStep ? ` · bin ${p.binStep}` : ""}` : "—";
  const slippage = c.jupiter?.slippagePct !== null && c.jupiter?.slippagePct !== undefined
    ? `${c.jupiter.slippagePct.toFixed(2)}% ($${c.jupiter.slippageProbeUsd})`
    : "—";

  const lines: string[] = [];
  lines.push("🔍 <b>Token Baru Terdeteksi</b>");
  lines.push("");
  lines.push(`<b>Token:</b> $${escapeHtml(p.target.symbol)}${p.target.name ? ` — ${escapeHtml(p.target.name)}` : ""}`);
  lines.push(`<b>Mint:</b> <code>${escapeHtml(p.target.mint)}</code>`);
  lines.push(`<b>Pool:</b> <a href="${poolUrl}">${escapeHtml(p.name)}</a> (${p.quote.symbol} pair)`);
  const feeTvl = p.feeTvlRatioPct !== null ? ` | <b>Fee/TVL:</b> ${p.feeTvlRatioPct.toFixed(2)}%` : "";
  lines.push(`<b>TVL:</b> ${fmtUsd(p.tvlUsd)} | <b>Vol ${defaultRules.fetcher.timeframe}:</b> ${fmtUsd(p.volumeWindowUsd)} | <b>V/TVL:</b> ${p.volumeToTvlRatio.toFixed(2)}${feeTvl}`);
  lines.push(`<b>Umur pool:</b> ${p.ageHours.toFixed(1)} jam | <b>Fee:</b> ${feeTier}`);
  lines.push(`<b>Harga (Jupiter):</b> ${fmtPrice(price)} | <b>Selisih vs OKX:</b> ${priceDiff}`);
  lines.push(`<b>Holders:</b> ${holders ?? "—"} | <b>Organic:</b> ${escapeHtml(organic)} | <b>Slippage:</b> ${slippage}`);
  const security = securityLine(c);
  if (security) lines.push(security);
  lines.push("");
  lines.push(`📊 <b>Skor LLM:</b> ${v.score}/100 ${meta.emoji} (${meta.label}) — via ${escapeHtml(c.llmProvider)}`);
  if (v.reasoning) lines.push(`<b>Alasan:</b> ${escapeHtml(v.reasoning)}`);

  if (v.red_flags.length) {
    lines.push("");
    lines.push("⚠️ <b>Red flags:</b>");
    for (const f of v.red_flags.slice(0, 6)) lines.push(`• ${escapeHtml(f)}`);
  }
  if (v.green_flags.length) {
    lines.push("");
    lines.push("✅ <b>Green flags:</b>");
    for (const f of v.green_flags.slice(0, 6)) lines.push(`• ${escapeHtml(f)}`);
  }
  if (c.enrichmentWarnings.length) {
    lines.push("");
    lines.push(`<i>Catatan enrichment: ${escapeHtml(c.enrichmentWarnings.join(", "))}</i>`);
  }

  lines.push("");
  lines.push(`<a href="${dexUrl}">DexScreener</a> | <a href="${poolUrl}">Meteora Pool</a>`);
  return lines.join("\n");
}

/** Send one candidate to the configured chat. Throws on send failure. */
export async function sendCandidate(c: ScreenedCandidate, rules: Rules = defaultRules): Promise<void> {
  const chatId = env.telegram.chatId;
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is not set");
  const text = formatCandidate(c, rules);
  await getBot().api.sendMessage(chatId, text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  log.info(`sent alert for $${c.pool.target.symbol} (score ${c.verdict.score})`);
}
