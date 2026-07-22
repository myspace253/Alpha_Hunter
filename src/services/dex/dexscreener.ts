import axios from "axios";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import type { TokenPair } from "../../types";

const client = axios.create({
  baseURL: env.DEXSCREENER_BASE_URL,
  timeout: 10_000,
});

/**
 * Fetches the latest token profiles/boosted tokens as a proxy for "new / trending" tokens.
 * DexScreener's public API does not expose a raw firehose of every new pair, so in production
 * you would primarily rely on Helius webhooks / Yellowstone gRPC for true "new pair" detection
 * and use DexScreener to enrich with market data.
 */
export async function searchPairsByQuery(query: string): Promise<TokenPair[]> {
  try {
    const { data } = await client.get(`/latest/dex/search`, { params: { q: query } });
    return (data?.pairs ?? []).filter((p: TokenPair) => p.chainId === "solana");
  } catch (err) {
    logger.error({ err }, "dexscreener.searchPairsByQuery failed");
    return [];
  }
}

export async function getPairsForTokenAddress(tokenAddress: string): Promise<TokenPair[]> {
  try {
    const { data } = await client.get(`/token-pairs/v1/solana/${tokenAddress}`);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.error({ err, tokenAddress }, "dexscreener.getPairsForTokenAddress failed");
    return [];
  }
}

export async function getPairByAddress(pairAddress: string): Promise<TokenPair | null> {
  try {
    const { data } = await client.get(`/latest/dex/pairs/solana/${pairAddress}`);
    const pairs: TokenPair[] = data?.pairs ?? [];
    return pairs[0] ?? null;
  } catch (err) {
    logger.error({ err, pairAddress }, "dexscreener.getPairByAddress failed");
    return null;
  }
}

/** Latest boosted/trending token profiles, useful as a cheap "what's hot" seed list. */
export async function getLatestBoostedTokens(): Promise<Array<{ tokenAddress: string; chainId: string }>> {
  try {
    const { data } = await client.get(`/token-boosts/latest/v1`);
    return (Array.isArray(data) ? data : []).filter((t: { chainId: string }) => t.chainId === "solana");
  } catch (err) {
    logger.error({ err }, "dexscreener.getLatestBoostedTokens failed");
    return [];
  }
}
