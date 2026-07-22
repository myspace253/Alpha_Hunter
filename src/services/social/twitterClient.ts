import axios from "axios";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";

const client = axios.create({
  baseURL: "https://api.twitter.com/2",
  timeout: 10_000,
  headers: env.TWITTER_BEARER_TOKEN ? { Authorization: `Bearer ${env.TWITTER_BEARER_TOKEN}` } : {},
});

function requireToken(): boolean {
  if (!env.TWITTER_BEARER_TOKEN) {
    logger.warn("TWITTER_BEARER_TOKEN not set — skipping Twitter/X social signal collection");
    return false;
  }
  return true;
}

interface TweetCountBucket {
  start: string;
  end: string;
  tweet_count: number;
}

/**
 * Returns hourly tweet-count buckets for a cashtag/symbol query over the last ~24-48h
 * (subject to your API access tier — the counts endpoint requires at least Basic access;
 * Essential/Free tiers do not include it as of this writing).
 *
 * Note: `$SYMBOL` cashtags are noisy for very short/common tickers (e.g. "$AI", "$GO") — callers
 * should treat low-liquidity, high-mention-count combos with a grain of salt.
 */
export async function getRecentMentionBuckets(symbol: string): Promise<TweetCountBucket[]> {
  if (!requireToken()) return [];
  try {
    const query = `$${symbol} -is:retweet`;
    const { data } = await client.get("/tweets/counts/recent", {
      params: { query, granularity: "hour" },
    });
    return data?.data ?? [];
  } catch (err) {
    logger.error({ err, symbol }, "twitterClient.getRecentMentionBuckets failed");
    return [];
  }
}

/** Sums mention counts across all returned buckets — a rough "total recent mentions" figure. */
export async function getTotalRecentMentions(symbol: string): Promise<number | null> {
  const buckets = await getRecentMentionBuckets(symbol);
  if (buckets.length === 0) return null;
  return buckets.reduce((sum, b) => sum + (b.tweet_count ?? 0), 0);
}
