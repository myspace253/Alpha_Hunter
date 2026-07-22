import { Pool } from "pg";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import type { AnalysisResult } from "../../types";

export const pool = new Pool({ connectionString: env.DATABASE_URL });

pool.on("error", (err) => {
  logger.error({ err }, "unexpected postgres pool error");
});

export async function saveAnalysis(result: AnalysisResult): Promise<void> {
  const { token, score, risk } = result;
  await pool.query(
    `INSERT INTO token_analysis
      (token_address, symbol, name, pair_address, ai_score, bullish_probability,
       expected_multiple, confidence, risk_score, risk_level, liquidity_usd, volume_24h_usd,
       holders, narrative, raw_snapshot, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
     ON CONFLICT (token_address) DO UPDATE SET
       ai_score = EXCLUDED.ai_score,
       bullish_probability = EXCLUDED.bullish_probability,
       expected_multiple = EXCLUDED.expected_multiple,
       confidence = EXCLUDED.confidence,
       risk_score = EXCLUDED.risk_score,
       risk_level = EXCLUDED.risk_level,
       liquidity_usd = EXCLUDED.liquidity_usd,
       volume_24h_usd = EXCLUDED.volume_24h_usd,
       holders = EXCLUDED.holders,
       narrative = EXCLUDED.narrative,
       raw_snapshot = EXCLUDED.raw_snapshot,
       updated_at = now()`,
    [
      token.address,
      token.symbol,
      token.name,
      token.pair.pairAddress,
      score.total,
      score.bullishProbabilityPct,
      score.expectedMultiple,
      score.confidencePct,
      risk.riskScore,
      risk.riskLevel,
      token.pair.liquidity?.usd ?? null,
      token.pair.volume?.h24 ?? null,
      token.onChain.totalHolders ?? null,
      token.narrative[0]?.category ?? null,
      JSON.stringify(token),
    ]
  );
}

export async function getTopScoredTokens(limit = 10) {
  const { rows } = await pool.query(
    `SELECT token_address, symbol, name, ai_score, risk_level, expected_multiple, confidence, created_at
     FROM token_analysis
     ORDER BY ai_score DESC, created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function addToWatchlist(chatId: string, tokenAddress: string, symbol: string) {
  await pool.query(
    `INSERT INTO watchlist (chat_id, token_address, symbol)
     VALUES ($1, $2, $3)
     ON CONFLICT (chat_id, token_address) DO NOTHING`,
    [chatId, tokenAddress, symbol]
  );
}

export async function getWatchlist(chatId: string) {
  const { rows } = await pool.query(
    `SELECT token_address, symbol, created_at FROM watchlist WHERE chat_id = $1 ORDER BY created_at DESC`,
    [chatId]
  );
  return rows;
}
