import { logger } from "../../utils/logger";
import {
  getLatestBoostedTokens,
  getPairsForTokenAddress,
} from "../dex/dexscreener";
import { getTokenSecurity, getTokenHolderCount } from "../dex/birdeye";
import type { OnChainMetrics, TokenSnapshot, NarrativeTag } from "../../types";
import { classifyNarrative } from "../scoring/narrativeClassifier";
import { analyzeWallets } from "../wallets/walletAnalyzer";
import { collectSocialMetrics } from "../social/socialMonitor";

/**
 * Discovers candidate tokens to analyze this scan cycle.
 * Seeds from DexScreener's boosted/trending feed. Swap this out for Helius webhook events
 * or a Yellowstone gRPC geyser stream for true real-time "new pair" detection.
 */
export async function discoverCandidateTokens(): Promise<string[]> {
  const boosted = await getLatestBoostedTokens();
  const addresses = boosted.map((t) => t.tokenAddress).filter(Boolean);
  return Array.from(new Set(addresses));
}

export async function buildTokenSnapshot(tokenAddress: string): Promise<TokenSnapshot | null> {
  const pairs = await getPairsForTokenAddress(tokenAddress);
  if (pairs.length === 0) {
    logger.debug({ tokenAddress }, "no pairs found for token, skipping");
    return null;
  }

  // Use the pair with the highest liquidity as the primary reference pair.
  const primaryPair = pairs.reduce((best, p) =>
    (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best
  );

  const [security, holderCount] = await Promise.all([
    getTokenSecurity(tokenAddress),
    getTokenHolderCount(tokenAddress),
  ]);

  const onChain: OnChainMetrics = {
    totalHolders: holderCount ?? undefined,
    mintAuthorityRevoked: security?.mintAuthorityRevoked,
    freezeAuthorityRevoked: security?.freezeAuthorityRevoked,
    topHolderPct: security?.topHolderPct,
    creatorWalletAgeDays: security?.creatorWalletAgeDays,
  };

  const [wallets, social] = await Promise.all([
    analyzeWallets(tokenAddress, {
      pairCreatedAt: primaryPair.pairCreatedAt,
      priceUsd: primaryPair.priceUsd ? Number(primaryPair.priceUsd) : null,
      // creatorAddress intentionally omitted here — resolving it requires walking the mint's
      // full signature history (heliusClient.estimateEarliestActivity) which is too slow to
      // run on every scan cycle. Wire it up as a one-time lookup cached in token_analysis
      // if "developer" wallet labeling becomes a priority.
    }),
    collectSocialMetrics(tokenAddress, primaryPair.baseToken.symbol),
  ]);

  const narrative: NarrativeTag[] = await classifyNarrative({
    tokenAddress,
    name: primaryPair.baseToken.name,
    symbol: primaryPair.baseToken.symbol,
    extra: social.trending ? "This token is currently trending on social media." : undefined,
  });

  const snapshot: TokenSnapshot = {
    address: tokenAddress,
    symbol: primaryPair.baseToken.symbol,
    name: primaryPair.baseToken.name,
    pair: primaryPair,
    onChain,
    wallets,
    social,
    narrative,
    collectedAt: new Date().toISOString(),
  };

  return snapshot;
}
