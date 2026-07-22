import axios from "axios";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";

const client = axios.create({
  baseURL: "https://lunarcrush.com/api4/public",
  timeout: 10_000,
  headers: env.LUNARCRUSH_API_KEY ? { Authorization: `Bearer ${env.LUNARCRUSH_API_KEY}` } : {},
});

function requireKey(): boolean {
  if (!env.LUNARCRUSH_API_KEY) {
    logger.warn("LUNARCRUSH_API_KEY not set — skipping LunarCrush social signal collection");
    return false;
  }
  return true;
}

export interface LunarCrushMetrics {
  socialVolume24h: number | null;
  /** Normalized -1 (bearish) to 1 (bullish); LunarCrush reports a 0-100 bullish-sentiment %. */
  sentimentScore: number | null;
  galaxyScore: number | null;
  altRank: number | null;
}

/**
 * LunarCrush primarily tracks established/listed coins, not every freshly-minted pump.fun token —
 * expect null results for very new/low-cap tokens and treat that as "no data", not "bad signal".
 */
export async function getCoinSocialMetrics(symbol: string): Promise<LunarCrushMetrics | null> {
  if (!requireKey()) return null;
  try {
    const { data } = await client.get(`/coins/${symbol}/v1`);
    const d = data?.data;
    if (!d) return null;

    // LunarCrush's `sentiment` field is typically a 0-100 "% bullish" score.
    const rawSentiment = typeof d.sentiment === "number" ? d.sentiment : null;

    return {
      socialVolume24h: d.social_volume_24h ?? d.interactions_24h ?? null,
      sentimentScore: rawSentiment !== null ? (rawSentiment - 50) / 50 : null,
      galaxyScore: d.galaxy_score ?? null,
      altRank: d.alt_rank ?? null,
    };
  } catch (err) {
    logger.error({ err, symbol }, "lunarcrush.getCoinSocialMetrics failed");
    return null;
  }
}
