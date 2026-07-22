import { pool } from "../db/postgres";

export type WalletLabel = "whale" | "smart_money" | "vc" | "sniper" | "insider" | "developer" | "unknown";

export interface WalletReputationRow {
  wallet_address: string;
  label: WalletLabel;
  historical_win_rate: number | null;
  avg_hold_days: number | null;
  total_trades: number;
  total_profit_pct: number | null;
  last_seen_at: string | null;
}

export async function getReputation(address: string): Promise<WalletReputationRow | null> {
  const { rows } = await pool.query(`SELECT * FROM wallet_reputation WHERE wallet_address = $1`, [address]);
  return rows[0] ?? null;
}

export async function getReputations(addresses: string[]): Promise<Map<string, WalletReputationRow>> {
  if (addresses.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT * FROM wallet_reputation WHERE wallet_address = ANY($1::text[])`,
    [addresses]
  );
  return new Map(rows.map((r: WalletReputationRow) => [r.wallet_address, r]));
}

/**
 * Upserts a wallet's label/last-seen timestamp without touching performance stats.
 * Performance stats (win rate, avg hold, profit) are only updated by `reputationUpdater.ts`
 * once positions actually close, so a fresh "unknown" wallet doesn't get penalized on sight.
 */
export async function upsertWalletSeen(address: string, label: WalletLabel): Promise<void> {
  await pool.query(
    `INSERT INTO wallet_reputation (wallet_address, label, last_seen_at)
     VALUES ($1, $2, now())
     ON CONFLICT (wallet_address) DO UPDATE SET
       label = CASE
         -- don't downgrade a wallet we've already classified with a stronger label
         WHEN wallet_reputation.label IN ('smart_money','vc','whale') AND EXCLUDED.label = 'unknown'
           THEN wallet_reputation.label
         ELSE EXCLUDED.label
       END,
       last_seen_at = now()`,
    [address, label]
  );
}

export type PositionAction = "buy" | "sell";

/** Records a detected buy/sell so the reputation updater can later compute realized performance. */
export async function recordPosition(params: {
  walletAddress: string;
  tokenAddress: string;
  action: PositionAction;
  uiAmount: number;
  priceUsd: number | null;
  signature: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO wallet_positions (wallet_address, token_address, action, ui_amount, price_usd, signature, detected_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (signature) DO NOTHING`,
    [params.walletAddress, params.tokenAddress, params.action, params.uiAmount, params.priceUsd, params.signature]
  );
}

export async function getTopWalletsByWinRate(limit = 20) {
  const { rows } = await pool.query(
    `SELECT wallet_address, label, historical_win_rate, avg_hold_days, total_trades, total_profit_pct
     FROM wallet_reputation
     WHERE total_trades >= 3
     ORDER BY historical_win_rate DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  return rows;
}
