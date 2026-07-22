import axios from "axios";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import type { OnChainMetrics } from "../../types";

const client = axios.create({
  baseURL: env.BIRDEYE_BASE_URL,
  timeout: 10_000,
  headers: env.BIRDEYE_API_KEY
    ? { "X-API-KEY": env.BIRDEYE_API_KEY, "x-chain": "solana" }
    : { "x-chain": "solana" },
});

function requireKey(): boolean {
  if (!env.BIRDEYE_API_KEY) {
    logger.warn("BIRDEYE_API_KEY not set — skipping Birdeye enrichment");
    return false;
  }
  return true;
}

export async function getTokenSecurity(tokenAddress: string): Promise<Partial<OnChainMetrics> | null> {
  if (!requireKey()) return null;
  try {
    const { data } = await client.get(`/defi/token_security`, { params: { address: tokenAddress } });
    const d = data?.data ?? {};
    return {
      mintAuthorityRevoked: d.mintAuthority === null || d.mintAuthority === undefined,
      freezeAuthorityRevoked: d.freezeAuthority === null || d.freezeAuthority === undefined,
      topHolderPct: d.top10HolderPercent ? Number(d.top10HolderPercent) * 100 : undefined,
      creatorWalletAgeDays: d.creatorWalletAgeDays,
    };
  } catch (err) {
    logger.error({ err, tokenAddress }, "birdeye.getTokenSecurity failed");
    return null;
  }
}

export async function getTokenHolderCount(tokenAddress: string): Promise<number | null> {
  if (!requireKey()) return null;
  try {
    const { data } = await client.get(`/defi/v3/token/holder`, {
      params: { address: tokenAddress, offset: 0, limit: 1 },
    });
    return data?.data?.items?.length !== undefined ? data?.data?.total ?? null : null;
  } catch (err) {
    logger.error({ err, tokenAddress }, "birdeye.getTokenHolderCount failed");
    return null;
  }
}

export async function getTrendingTokens(): Promise<Array<{ address: string; symbol: string }>> {
  if (!requireKey()) return [];
  try {
    const { data } = await client.get(`/defi/token_trending`, {
      params: { sort_by: "rank", sort_type: "asc", offset: 0, limit: 20 },
    });
    return data?.data?.tokens ?? [];
  } catch (err) {
    logger.error({ err }, "birdeye.getTrendingTokens failed");
    return [];
  }
}
