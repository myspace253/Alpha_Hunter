# Solana AI Alpha Hunter 🚀

An AI-powered Solana token scanner that goes beyond "new token detected" alerts. It scores every
token with a weighted composite of on-chain, wallet, social, and narrative signals, flags rugpull /
honeypot risk, and pushes explainable alerts to Telegram.

> Status: **MVP scaffold**. Core pipeline (scan → score → risk → alert → Telegram) is fully wired
> and functional against real DexScreener/Birdeye/Helius APIs. Social signal collection, wallet
> reputation history, and the ML scoring models described in the roadmap are stubbed with clear
> `TODO`s — see [Roadmap](#roadmap) below.

## What it does

- Continuously scans Solana for new and re-heating tokens (new listings, whale accumulation,
  rising liquidity, viral social activity).
- Pulls signals from on-chain data (holders, LP, mint/freeze authority), DEX data (liquidity,
  volume, price action), wallet behavior (whale / smart-money buying), and social/narrative
  context.
- Runs everything through a transparent, weighted **AI Score** (0–100) plus a separate **Risk
  Score** (rugpull / honeypot / manipulation flags).
- Sends Telegram alerts with an explanation ("why is this token good?") instead of a bare number.
- Supports `/analysis`, `/risk`, `/hot`, `/new`, `/watch`, `/compare`, and more via Telegram
  commands.

## Architecture

```
Telegram Bot
     │
     ▼
API/Bot Layer (Telegraf)
     │
 ┌───┼───────────────┬────────────────┐
 │   │                │                │
 ▼   ▼                ▼                ▼
Token Scanner   Wallet Analysis   Social Monitor
 │               │                │
 └───────────────┼────────────────┘
                  ▼
           AI Scoring Engine ── Risk Engine
                  │
                  ▼
          PostgreSQL (token_analysis, watchlist, alert_history)
                  │
                  ▼
          Telegram Alert Service
```

## Tech stack

| Layer          | Choice |
|----------------|--------|
| Language       | TypeScript / Node.js 18+ |
| Bot framework  | Telegraf |
| Data providers | DexScreener (free), Birdeye, Helius RPC/webhooks, Jupiter |
| Database       | PostgreSQL |
| Cache (future) | Redis |
| Scheduler      | `node-cron` / `setInterval` |
| Validation     | Zod |
| Logging        | Pino |

## Project layout

```
alpha-hunter/
├── .env.example              # copy to .env and fill in
├── docker-compose.yml        # Postgres + Redis + bot for local dev
├── Dockerfile
├── src/
│   ├── index.ts               # entrypoint
│   ├── config/env.ts          # validated env config
│   ├── types/index.ts         # shared types (TokenSnapshot, AlphaScore, etc.)
│   ├── services/
│   │   ├── scanJob.ts          # scheduled scan → score → alert cycle
│   │   ├── solana/
│   │   │   ├── tokenScanner.ts    # discovers + assembles token snapshots
│   │   │   └── heliusClient.ts    # Solana RPC + webhook registration
│   │   ├── dex/
│   │   │   ├── dexscreener.ts     # free public API — pairs, liquidity, volume
│   │   │   └── birdeye.ts         # holder counts, security, trending
│   │   ├── wallets/
│   │   │   ├── walletAnalyzer.ts     # top-holder resolution, classification, buy/sell detection
│   │   │   ├── walletReputation.ts   # DB layer for wallet_reputation / wallet_positions
│   │   │   └── reputationUpdater.ts  # hourly job: FIFO-matches trades, recomputes win rates
│   │   ├── scoring/
│   │   │   ├── scoringEngine.ts   # weighted AI Score (0-100)
│   │   │   ├── riskEngine.ts      # rugpull/honeypot risk flags
│   │   │   ├── narrativeClassifier.ts
│   │   │   └── analyze.ts         # orchestrates score + risk + explanations
│   │   ├── db/
│   │   │   ├── postgres.ts
│   │   │   ├── schema.sql
│   │   │   └── migrate.ts
│   │   └── telegram/
│   │       ├── bot.ts             # Telegraf commands + alert broadcaster
│   │       └── formatters.ts      # message templates
│   └── utils/logger.ts
```

## Getting started

### 1. Prerequisites

- Node.js 18.17+
- PostgreSQL 14+ (or use the provided `docker-compose.yml`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A [Helius](https://helius.dev) API key (free tier works for RPC calls)
- Optionally: a [Birdeye](https://birdeye.so) API key for holder counts + security checks

### 2. Install

```bash
git clone https://github.com/myspace253/Alpha_Hunter.git
cd alpha-hunter
npm install
```

### 3. Configure

```bash
cp .env.example .env
```

Then edit `.env` and fill in at minimum:

```
TELEGRAM_BOT_TOKEN=...
DATABASE_URL=postgresql://alpha_hunter:change_me@localhost:5432/alpha_hunter
HELIUS_API_KEY=...
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
```

See `.env.example` for the full list of optional providers (Birdeye, Twitter, LunarCrush,
CryptoPanic, OpenAI) and alert thresholds (`MIN_ALERT_SCORE`, `MAX_ALERT_RISK`).

### 4. Start Postgres (and Redis)

```bash
docker compose up -d postgres redis
```

Or point `DATABASE_URL` at an existing Postgres instance.

### 5. Run migrations

```bash
npm run migrate
```

This applies `src/services/db/schema.sql` — creates `token_analysis`, `wallet_reputation`,
`watchlist`, `alert_history`, and `backtest_results` tables.

### 6. Run the bot

```bash
npm run dev      # ts-node/tsx with auto-reload, for development
# or
npm run build && npm start   # compiled production run
```

On startup the bot verifies the DB connection, launches the Telegraf bot, schedules the recurring
scan job (`SCAN_INTERVAL_SECONDS`, default 30s), and runs one scan cycle immediately.

### 7. Talk to your bot

In Telegram, message your bot and try:

```
/start
/help
/analysis <token_address>
/hot
/watch <token_address>
```

## Telegram commands (MVP set)

| Command | Description |
|---|---|
| `/start`, `/help` | intro + command list |
| `/new` | recently scanned tokens |
| `/hot` | highest AI-scored tokens right now |
| `/trending` | tokens with rising signals |
| `/analysis <address>` | full AI score + risk + explanation |
| `/risk <address>` | risk-only breakdown |
| `/whales <address>` | whale/smart-money wallet activity |
| `/wallet [address]` | a wallet's reputation profile, or top wallets by win rate if omitted |
| `/narrative <address>` | detected narrative tags |
| `/compare <addr1> <addr2>` | side-by-side comparison |
| `/watch <address>` | add to personal watchlist |
| `/watchlist` | show your watchlist |
| `/settings` | view current alert thresholds |

## How the AI Score works

The composite `AI Score` (0-100) is a weighted blend, matching the original spec:

| Signal | Weight |
|---|---|
| Liquidity | 25% |
| Whale / smart-money activity | 20% |
| Volume | 15% |
| Social | 15% |
| Holder growth | 10% |
| Narrative | 10% |
| Developer activity | 5% |

Each sub-score is normalized 0-100 against a target threshold (e.g. $100k liquidity ≈ 100 points),
then combined. A separate **Risk Engine** independently flags mint/freeze authority status, LP
burn status, holder concentration, and volume-to-liquidity ratio (a wash-trading heuristic), and
discounts the final "bullish probability" accordingly. Every alert includes the plain-language
reasons behind both scores — see `scoringEngine.ts::explainScore()` and `riskEngine.ts`.

This rule-based engine is intentionally transparent and easy to audit for the MVP. It's designed
to be swapped out module-by-module for trained models (XGBoost/LightGBM/CatBoost for scoring,
embeddings for narrative classification) without touching the rest of the pipeline — see below.

## Roadmap

This scaffold implements the **MVP** phase end-to-end. What's stubbed vs. real:

**Real / working now:**
- DexScreener integration (pairs, liquidity, volume, boosted/trending seed list)
- Birdeye integration (holder count, mint/freeze authority, top-holder concentration)
- Helius RPC client (largest accounts, supply, account info, webhook registration)
- Weighted AI scoring engine + rule-based risk engine
- PostgreSQL persistence + watchlist
- Telegram bot with the full MVP command set
- Scheduled scan → score → alert loop

**Also real now — Whale & Smart-Money Wallet Tracking:**
- `services/wallets/walletAnalyzer.ts` resolves the top holders of every scanned token
  (`getTokenLargestAccounts` → owner resolution via parsed account info), classifies each wallet
  (`whale`, `sniper`, `developer`, or a reputation-table label like `smart_money`), and checks
  Helius's enhanced-transactions API for recent buy/sell activity.
- Every observed buy/sell is written to a new `wallet_positions` table.
- `services/wallets/reputationUpdater.ts` runs hourly, matches buy→sell pairs FIFO per
  wallet+token, and recomputes each wallet's win rate, average hold time, and average profit —
  wallets with a ≥65% win rate over 3+ closed trades get auto-promoted to `smart_money`, feeding
  directly into the Whale Score (20% of the AI Score).
- `/whales <address>` and the new `/wallet [address]` Telegram command expose this — `/wallet`
  with no argument lists the current top wallets by win rate.
- Known limitation: wallet/token "age" and buy-timing (used for sniper detection) rely on
  `getSignaturesForAddress`, which only sees a rolling history window on public RPC nodes — good
  enough for recent launches, not archival-accurate for old wallets.

**Stubbed (clear `TODO` markers in code) — ready for Version 2/3 work:**
- `tokenScanner.ts::collectSocialMetrics()` — wire to Twitter/X API, Telegram, LunarCrush
- `scoringEngine.ts::computeDeveloperScore()` — wire to GitHub API for AI-narrative tokens
- `narrativeClassifier.ts` — currently keyword-based; swap for Sentence-Transformers embeddings
- `riskEngine.ts::honeypotRisk` — needs a simulated sell-transaction check via RPC
- AI Assistant chat ("why is this token good?" free-form Q&A via LLM) — `OPENAI_API_KEY` is
  already in `.env.example`; add an `aiAssistant.ts` service that feeds `AnalysisResult` as
  context to the LLM
- Backtesting engine — `backtest_results` table exists; needs a historical price replay job
- Web dashboard (Vue 3 + Tailwind, per the original spec) — not included in this backend-only
  scaffold

## Disclaimer

This tool surfaces signals for research purposes only — it is not financial advice. On-chain
scoring heuristics can be wrong, and low-cap Solana tokens carry very high risk including total
loss of funds. Always do your own research before trading.
