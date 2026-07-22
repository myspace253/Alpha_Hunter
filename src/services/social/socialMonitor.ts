import { pool } from "../db/postgres";
import { logger } from "../../utils/logger";
import type { SocialMetrics } from "../../types";
import { getTotalRecentMentions } from "./twitterClient";
import { getCoinSocialMetrics } from "./lunarcrush";

// A token needs to clear this bar (and be growing) before we call it "trending" — keeps
// low-volume noise (a handful of bot mentions) from tripping the flag.
const TRENDING_MIN_MENTIONS = 20;
const TRENDING_MIN_GROWTH_PCT = 50;

async function saveSnapshot(params: {
  tokenAddress: string;
  symbol: string;
  source: "twitter" | "lunarcrush";
  mentions: number | null;
  sentimentScore: number | null;
}) {
  try {
    await pool.query(
      `INSERT INTO social_snapshots (token_address, symbol, source, mentions, sentiment_score, collected_at)
       VALUES ($1,$2,$3,$4,$5, now())`,
      [params.tokenAddress, params.symbol, params.source, params.mentions, params.sentimentScore]
    );
  } catch (err) {
    logger.error({ err, params }, "socialMonitor: failed to save snapshot");
  }
}

/**
 * Computes mention growth for a token by comparing our own recorded snapshot history
 * (last 24h vs the preceding 24h) — same pattern as narrativeTrends.ts. This is more robust
 * than trusting an external API's self-reported "24h change" field, which not all providers
 * expose consistently.
 */
async function computeMentionGrowthPct(tokenAddress: string): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ window_label: "recent" | "prior"; total: string }>(
      `SELECT
         CASE WHEN collected_at > now() - interval '24 hours' THEN 'recent' ELSE 'prior' END AS window_label,
         COALESCE(SUM(mentions), 0) AS total
       FROM social_snapshots
       WHERE token_address = $1
         AND collected_at > now() - interval '48 hours'
         AND mentions IS NOT NULL
       GROUP BY window_label`,
      [tokenAddress]
    );

    const recent = Number(rows.find((r) => r.window_label === "recent")?.total ?? 0);
    const prior = Number(rows.find((r) => r.window_label === "prior")?.total ?? 0);

    if (prior === 0 && recent === 0) return null; // no data at all yet
    if (prior === 0) return 100; // brand-new mention activity — treat as strong growth
    return ((recent - prior) / prior) * 100;
  } catch (err) {
    logger.error({ err, tokenAddress }, "socialMonitor: computeMentionGrowthPct failed");
    return null;
  }
}

/**
 * Collects social signals for a token from LunarCrush (crypto-native sentiment/social volume)
 * and Twitter/X (cashtag mention counts), records a snapshot for future growth tracking, and
 * returns the combined SocialMetrics used by the scoring engine.
 *
 * Telegram member growth is intentionally left unset — tracking an arbitrary token's Telegram
 * channel requires the bot to be a member/admin of that specific channel, which isn't something
 * we can do generically for every token we scan. Wire it up per-community if needed.
 */
export async function collectSocialMetrics(tokenAddress: string, symbol: string): Promise<SocialMetrics> {
  const [lunarcrush, twitterMentions] = await Promise.all([
    getCoinSocialMetrics(symbol),
    getTotalRecentMentions(symbol),
  ]);

  // Prefer LunarCrush's mention count when available (it aggregates more than just Twitter);
  // fall back to our own Twitter count.
  const mentions24h = lunarcrush?.socialVolume24h ?? twitterMentions ?? null;
  const sentimentScore = lunarcrush?.sentimentScore ?? null;

  if (mentions24h !== null) {
    await saveSnapshot({
      tokenAddress,
      symbol,
      source: lunarcrush?.socialVolume24h !== null && lunarcrush !== null ? "lunarcrush" : "twitter",
      mentions: mentions24h,
      sentimentScore,
    });
  }

  const mentionGrowthPct = await computeMentionGrowthPct(tokenAddress);

  const trending =
    mentions24h !== null &&
    mentions24h >= TRENDING_MIN_MENTIONS &&
    (mentionGrowthPct ?? 0) >= TRENDING_MIN_GROWTH_PCT;

  return {
    twitterMentions24h: twitterMentions ?? undefined,
    twitterMentionGrowthPct: mentionGrowthPct ?? undefined,
    telegramMemberGrowthPct: undefined, // see note above
    sentimentScore: sentimentScore ?? undefined,
    trending,
  };
}
