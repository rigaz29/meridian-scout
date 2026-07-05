# meridian-scout

[![CI](https://github.com/rigaz29/meridian-scout/actions/workflows/ci.yml/badge.svg)](https://github.com/rigaz29/meridian-scout/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A **read-only** screener for [Meteora DLMM](https://www.meteora.ag/) pools on Solana. It polls active/new pools, filters them by quantitative rules, deep-dives the survivors with an LLM, and pushes the results to Telegram.

> **No trading. No wallets. No transactions.** This bot never signs anything or deploys liquidity — it only reads public data, scores it, and notifies you. (Architecture is inspired by [meridian](https://github.com/yunus-0x/meridian), but only the data-fetching patterns were reused — none of the wallet / transaction / LP-position code.)

```
┌───────────┐   ┌──────────────┐   ┌───────────────┐   ┌───────────────────┐   ┌──────────────┐
│ Scheduler │ → │ Meteora      │ → │ Rule filter   │ → │ LLM deep-dive     │ → │ Telegram     │
│ node-cron │   │ data fetch   │   │ (2 stages) +  │   │ (OpenRouter →     │   │ notifier     │
│           │   │ + enrichment │   │ dedupe store  │   │  DeepSeek)        │   │ (grammy)     │
└───────────┘   └──────────────┘   └───────────────┘   └───────────────────┘   └──────────────┘
                 Jupiter + OKX      cheap → expensive     JSON verdict (zod)      max N / cycle
```

---

## What it does, stage by stage

1. **Fetch** — pulls new, active DLMM pools from the Meteora **Pool Discovery API** (`pool-discovery-api.datapi.meteora.ag/pools`). The stage-1 TVL / volume / pool-age gates are pushed into the API's `filter_by` DSL, so filtering happens **server-side** (plus free safety filters that drop critically-warned and single-owner tokens) and results come back newest-first. Each pool is normalized into a "one target token vs one quote asset (SOL/USDC/USDT)" shape, carrying extra signals the discovery API provides: mint/freeze-authority flags, top-holder %, token warnings, volatility, swap count, unique traders.
2. **Dedupe** — pools already processed in a previous cycle are skipped (state kept in a local JSON file — no database).
3. **Stage-1 rules (cheap)** — Meteora-only gate: min TVL, min 24h volume, max pool age, min volume/TVL ratio, **min 24h fee/TVL ratio** (the core DLMM pool-quality metric), **mint & freeze authority must be revoked** (rug-safety), optional top-holder cap, and blacklist. Runs *before* spending any enrichment API calls (the numeric gates are pushed server-side).
4. **Enrichment** — for stage-1 survivors, pulls:
   - **Jupiter** (`datapi.jup.ag` + `api.jup.ag`): listing/verification, price, cross-DEX liquidity, holder count, organic score, on-chain audit (mint/freeze authority, top-holder %), and **slippage** for a $-sized probe swap.
   - **OKX DEX** (`web3.okx.com`, optional): cross-check price + liquidity, plus token security data (risk level, bundle/sniper/dev %, honeypot).
   - Enrichment is **best-effort**: if Jupiter or OKX is down/rate-limited, the cycle continues with whatever data it has.
5. **Stage-2 rules** — enrichment-dependent gate: must be Jupiter-listed, slippage under threshold, Jupiter-vs-OKX price difference under threshold, optional holder floor. Rules whose data is missing are *skipped*, never failed.
6. **LLM deep-dive** — survivors go to an LLM (via OpenRouter, with automatic DeepSeek fallback) which returns a **strict JSON verdict** (`score`, `verdict`, `reasoning`, `red_flags`, `green_flags`), validated with zod. The LLM only scores — it makes no trading decision.
7. **Notify** — tokens scoring ≥ threshold are sent to Telegram (rate-limited per cycle). Sent pools are recorded so they're not re-alerted.

---

## Requirements

- **Node.js ≥ 20** (uses the built-in `fetch`).
- A **Telegram bot** + chat/channel id.
- An **OpenRouter** API key (and optionally a **DeepSeek** key for fallback).
- Optional: **Jupiter** API key (higher rate limits), **OKX** DEX API keys (enables the cross-DEX check).

## Install

```bash
npm install
npm run setup      # interactive wizard — just paste each value when asked
npm run build
```

`npm run setup` walks you through every credential paste-by-paste, writes your `.env`, and offers to send a Telegram test message to confirm the bot works. (Prefer to do it by hand? `cp .env.example .env` and edit — see the table below.)

## Quick test (no keys needed for these)

```bash
npm run test:fetch        # fetch live Meteora pools, print the youngest ones
npm run test:enrich       # enrich a few pools via Jupiter (OKX skipped without keys)
```

## Run

```bash
npm run once              # run exactly one full cycle, then exit (needs Telegram + LLM keys)
npm run dev               # watch mode (tsx), reruns on file change
npm start                 # production: run on the node-cron schedule (after npm run build)
```

### Deploy with PM2

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 logs meteora-screener
pm2 save && pm2 startup    # restart on reboot
```

### Deploy with systemd

```ini
# /etc/systemd/system/meteora-screener.service
[Unit]
Description=meridian-scout
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/meridian-scout
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/meridian-scout/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now meteora-screener
journalctl -u meteora-screener -f
```

---

## Configuration

There are two config surfaces:

- **`.env`** — secrets, credentials, and runtime knobs (poll interval, log level, LLM model).
- **`config.yaml`** — all screening **thresholds/rules**. Edit and restart; no code changes needed.

### `.env` — how to get each key

| Variable | Required | How to get it |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | ✅ | Create a bot with [@BotFather](https://t.me/BotFather) → `/newbot`. |
| `TELEGRAM_CHAT_ID` | ✅ | DM [@userinfobot](https://t.me/userinfobot) for your personal id, or add your bot to a channel as admin and use the channel id (e.g. `-100…`). |
| `OPENROUTER_API_KEY` | ✅ | [openrouter.ai/keys](https://openrouter.ai/keys). |
| `DEEPSEEK_API_KEY` | optional | [platform.deepseek.com](https://platform.deepseek.com) — used only as the fallback when OpenRouter fails. |
| `LLM_MODEL` | — | Default `deepseek/deepseek-chat` (cheap). Swap to `deepseek/deepseek-r1` for deeper reasoning. |
| `JUPITER_API_KEY` | optional | [portal.jup.ag](https://portal.jup.ag). Keyless works on a free tier; a key raises rate limits. |
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` | optional | [web3.okx.com](https://web3.okx.com) → Developer portal. Without these, the OKX cross-check is skipped (enrichment degrades gracefully). |
| `POLL_INTERVAL_MINUTES` | — | Cycle interval (default 7). |

### `config.yaml` — tuning thresholds

Everything the screener decides on is here. Highlights (see the file for the full annotated list):

```yaml
stage1:
  minTvlUsd: 10000              # minimum pool liquidity (thin = risk)
  minVolume24hUsd: 15000        # minimum 24h volume
  maxPoolAgeHours: 48           # focus on new pools
  minVolumeToTvlRatio: 1.0      # trading activity vs liquidity
  minFeeTvlRatioPct: 0.4        # 24h fee/TVL floor — core DLMM quality metric (sweet spot ~0.4-1%)
  requireMintAuthorityRevoked: true    # rug-safety
  requireFreezeAuthorityRevoked: true  # rug-safety
  maxTopHoldersPct: 0           # 0 = off (metric can include CEX/pool wallets)

stage2:
  requireJupiterListed: true
  maxSlippagePct: 5.0            # Jupiter price impact on a $200 swap
  slippageProbeUsd: 200
  maxJupiterOkxPriceDiffPct: 3.0 # price-manipulation guard (needs OKX keys)
  minHolders: 0                  # set e.g. 50 to require holders

analyzer:
  minScoreToNotify: 60           # LLM score gate for a Telegram alert
  maxCandidatesPerCycle: 12      # cost control on LLM calls

notifier:
  maxNotificationsPerCycle: 5    # flood protection
```

The stage-1 gates (`minTvlUsd`, `minVolume24hUsd`, `maxPoolAgeHours`) are applied **server-side** by the discovery API, so raising/lowering them directly changes what's fetched. To **fetch more pools per cycle**, raise `fetcher.pageSize` (max 200). To **screen a wider set of quote assets**, edit `fetcher.quoteMints`. `fetcher.timeframe` (default `24h`) sets the window for the returned volume/fee numbers; `fetcher.category` can be `all`, `new`, or `trending`.

---

## Data sources / endpoints

| Provider | Base | Used for | Auth |
| --- | --- | --- | --- |
| Meteora Pool Discovery | `https://pool-discovery-api.datapi.meteora.ag` | server-side filtered pool list (`/pools`), rich metrics + safety flags | none |
| Jupiter datapi | `https://datapi.jup.ag/v1` | `assets/search` — price, liquidity, holders, audit, organic score | keyless / optional key |
| Jupiter swap | `https://api.jup.ag/swap/v1` | `quote` — slippage & route depth | keyless / optional key |
| OKX DEX | `https://web3.okx.com` | `price-info`, `advanced-info` — cross-DEX price, security | HMAC (API keys) |
| OpenRouter | `https://openrouter.ai/api/v1` | LLM analysis (primary) | API key |
| DeepSeek | `https://api.deepseek.com` | LLM analysis (fallback) | API key |

> These endpoints were verified against live responses at build time. If a provider changes its shape, the zod validators will surface the drift loudly instead of silently reading `undefined` — check the logs for "shape changed / failed validation".

---

## Logging

Each cycle logs a one-line summary: how many pools were fetched, how many were new, how many passed each stage, how many were analyzed, and how many alerts were sent. Set `LOG_LEVEL=debug` in `.env` to see per-token reject reasons, and `LOG_FILE=logs/screener.log` to also append logs to a file.

## What this bot intentionally does **not** do

- No wallet integration, no private keys.
- No transaction signing, no LP deployment, no auto-trading of any kind.
- No web UI — CLI/logs + Telegram output only.

The LLM is used for **analysis and scoring only**, never to trigger any on-chain action.
