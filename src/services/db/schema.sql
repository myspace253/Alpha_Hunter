-- Solana AI Alpha Hunter — core schema
-- Run via: psql "$DATABASE_URL" -f src/services/db/schema.sql
-- or:      npm run migrate

CREATE TABLE IF NOT EXISTS token_analysis (
  id                    BIGSERIAL PRIMARY KEY,
  token_address         TEXT NOT NULL UNIQUE,
  symbol                TEXT NOT NULL,
  name                  TEXT NOT NULL,
  pair_address          TEXT,
  ai_score              NUMERIC(5,2) NOT NULL,
  bullish_probability   NUMERIC(5,2),
  expected_multiple     TEXT,
  confidence            NUMERIC(5,2),
  risk_score            NUMERIC(5,2) NOT NULL,
  risk_level            TEXT NOT NULL,
  liquidity_usd         NUMERIC(18,2),
  volume_24h_usd        NUMERIC(18,2),
  holders               INTEGER,
  narrative             TEXT,
  raw_snapshot          JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_token_analysis_score ON token_analysis (ai_score DESC);
CREATE INDEX IF NOT EXISTS idx_token_analysis_created ON token_analysis (created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_reputation (
  id                    BIGSERIAL PRIMARY KEY,
  wallet_address        TEXT NOT NULL UNIQUE,
  label                 TEXT NOT NULL DEFAULT 'unknown', -- whale, smart_money, vc, sniper, insider, developer
  historical_win_rate   NUMERIC(5,2),
  avg_hold_days         NUMERIC(6,2),
  total_trades          INTEGER DEFAULT 0,
  total_profit_pct      NUMERIC(10,2),
  last_seen_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_positions (
  id                    BIGSERIAL PRIMARY KEY,
  wallet_address        TEXT NOT NULL,
  token_address         TEXT NOT NULL,
  action                TEXT NOT NULL CHECK (action IN ('buy','sell')),
  ui_amount             NUMERIC(24,6),
  price_usd             NUMERIC(24,10),
  signature             TEXT NOT NULL UNIQUE,
  detected_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_positions_wallet_token
  ON wallet_positions (wallet_address, token_address, detected_at);

CREATE TABLE IF NOT EXISTS watchlist (
  id                    BIGSERIAL PRIMARY KEY,
  chat_id               TEXT NOT NULL,
  token_address         TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id, token_address)
);

CREATE TABLE IF NOT EXISTS alert_history (
  id                    BIGSERIAL PRIMARY KEY,
  token_address         TEXT NOT NULL,
  chat_id               TEXT NOT NULL,
  ai_score              NUMERIC(5,2),
  risk_level            TEXT,
  alert_type            TEXT NOT NULL DEFAULT 'new_alpha', -- new_alpha, whale_buy, liquidity_up, watchlist_trigger
  sent_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_history_token ON alert_history (token_address, sent_at DESC);

CREATE TABLE IF NOT EXISTS backtest_results (
  id                    BIGSERIAL PRIMARY KEY,
  strategy_name         TEXT NOT NULL,
  token_address         TEXT NOT NULL,
  entry_score           NUMERIC(5,2),
  entry_price_usd       NUMERIC(24,10),
  exit_price_usd        NUMERIC(24,10),
  return_pct            NUMERIC(10,2),
  holding_period_hours  NUMERIC(10,2),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
