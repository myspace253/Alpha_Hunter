import { pool } from "../db/postgres";
import { logger } from "../../utils/logger";

interface PositionRow {
  wallet_address: string;
  token_address: string;
  action: "buy" | "sell";
  ui_amount: string | null;
  price_usd: string | null;
  detected_at: string;
}

interface ClosedTrade {
  returnPct: number;
  holdDays: number;
}

/**
 * Matches buy/sell positions FIFO per wallet+token to compute realized trades, then aggregates
 * win rate / avg hold time / avg profit per wallet into `wallet_reputation`.
 *
 * This is intentionally a full recompute over all positions each run (simple and correct for
 * MVP data volumes). At scale, switch to incremental matching with a `matched` flag on
 * `wallet_positions`.
 */
export async function updateWalletReputations(): Promise<void> {
  const { rows } = await pool.query<PositionRow>(
    `SELECT wallet_address, token_address, action, ui_amount, price_usd, detected_at
     FROM wallet_positions
     WHERE price_usd IS NOT NULL
     ORDER BY wallet_address, token_address, detected_at ASC`
  );

  if (rows.length === 0) {
    logger.info("reputationUpdater: no priced positions to process yet");
    return;
  }

  // Group by wallet+token
  const groups = new Map<string, PositionRow[]>();
  for (const row of rows) {
    const key = `${row.wallet_address}::${row.token_address}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const tradesByWallet = new Map<string, ClosedTrade[]>();

  for (const [key, positions] of groups) {
    const [walletAddress] = key.split("::");
    const buyQueue: PositionRow[] = [];

    for (const pos of positions) {
      if (pos.action === "buy") {
        buyQueue.push(pos);
        continue;
      }
      // action === "sell": match against the oldest unmatched buy (FIFO)
      const buy = buyQueue.shift();
      if (!buy || buy.price_usd === null || pos.price_usd === null) continue;

      const buyPrice = Number(buy.price_usd);
      const sellPrice = Number(pos.price_usd);
      if (buyPrice <= 0) continue;

      const returnPct = ((sellPrice - buyPrice) / buyPrice) * 100;
      const holdDays =
        (new Date(pos.detected_at).getTime() - new Date(buy.detected_at).getTime()) / 86_400_000;

      if (!tradesByWallet.has(walletAddress)) tradesByWallet.set(walletAddress, []);
      tradesByWallet.get(walletAddress)!.push({ returnPct, holdDays: Math.max(0, holdDays) });
    }
  }

  let updated = 0;
  for (const [walletAddress, trades] of tradesByWallet) {
    if (trades.length === 0) continue;

    const wins = trades.filter((t) => t.returnPct > 0).length;
    const winRate = (wins / trades.length) * 100;
    const avgHoldDays = trades.reduce((s, t) => s + t.holdDays, 0) / trades.length;
    const avgProfitPct = trades.reduce((s, t) => s + t.returnPct, 0) / trades.length;

    // Wallets with a strong track record earn a "smart_money" upgrade; degraded ones fall back
    // to "unknown" so the scoring engine stops treating them as a positive signal.
    const label =
      trades.length >= 3 && winRate >= 65
        ? "smart_money"
        : trades.length >= 3 && winRate < 35
        ? "unknown"
        : null; // insufficient sample — leave existing label untouched

    await pool.query(
      `INSERT INTO wallet_reputation
         (wallet_address, label, historical_win_rate, avg_hold_days, total_trades, total_profit_pct, last_seen_at)
       VALUES ($1, COALESCE($2, 'unknown'), $3, $4, $5, $6, now())
       ON CONFLICT (wallet_address) DO UPDATE SET
         label = COALESCE($2, wallet_reputation.label),
         historical_win_rate = EXCLUDED.historical_win_rate,
         avg_hold_days = EXCLUDED.avg_hold_days,
         total_trades = EXCLUDED.total_trades,
         total_profit_pct = EXCLUDED.total_profit_pct,
         last_seen_at = now()`,
      [walletAddress, label, winRate, avgHoldDays, trades.length, avgProfitPct]
    );
    updated++;
  }

  logger.info({ walletsUpdated: updated, groupsProcessed: groups.size }, "reputationUpdater run complete");
}
