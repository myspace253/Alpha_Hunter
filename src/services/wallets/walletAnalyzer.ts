import { logger } from "../../utils/logger";
import {
  getTokenLargestAccounts,
  getTokenSupply,
  resolveTokenAccountOwner,
  hasRecentBuy,
  hasRecentSell,
  estimateEarliestActivity,
} from "../solana/heliusClient";
import { getReputations, upsertWalletSeen, recordPosition, type WalletLabel } from "./walletReputation";
import type { WalletSignal } from "../../types";

const WHALE_SUPPLY_PCT_THRESHOLD = 3; // holding >3% of supply is "whale" territory for a low-cap token
const SNIPER_WINDOW_MINUTES = 10; // bought within 10 min of pair creation
const MAX_HOLDERS_TO_ANALYZE = 10; // getTokenLargestAccounts caps at 20; we only deep-dive the top N

interface TopHolder {
  tokenAccount: string;
  ownerAddress: string | null;
  uiAmount: number;
  pctOfSupply: number;
}

async function getTopHolders(mintAddress: string): Promise<TopHolder[]> {
  const [largest, supply] = await Promise.all([
    getTokenLargestAccounts(mintAddress),
    getTokenSupply(mintAddress),
  ]);

  if (!largest?.value?.length || !supply?.value?.uiAmount) return [];

  const totalSupply = supply.value.uiAmount;
  const accounts = largest.value.slice(0, MAX_HOLDERS_TO_ANALYZE);

  const owners = await Promise.all(
    accounts.map(async (acc) => ({
      tokenAccount: acc.address,
      ownerAddress: await resolveTokenAccountOwner(acc.address),
      uiAmount: acc.uiAmount,
      pctOfSupply: totalSupply > 0 ? (acc.uiAmount / totalSupply) * 100 : 0,
    }))
  );

  return owners;
}

/**
 * Classifies a wallet using: (1) any existing reputation-table label, which wins by default,
 * then (2) cheap on-chain heuristics — supply share, and buy-timing relative to pair creation.
 */
async function classifyWallet(params: {
  ownerAddress: string;
  pctOfSupply: number;
  creatorAddress?: string | null;
  pairCreatedAt?: number; // ms epoch
  existingLabel?: WalletLabel;
}): Promise<WalletLabel> {
  const { ownerAddress, pctOfSupply, creatorAddress, pairCreatedAt, existingLabel } = params;

  if (existingLabel && existingLabel !== "unknown") return existingLabel;

  if (creatorAddress && ownerAddress === creatorAddress) return "developer";

  if (pairCreatedAt) {
    const { blockTime } = await estimateEarliestActivity(ownerAddress, 1);
    if (blockTime) {
      const walletFirstSeenMs = blockTime * 1000;
      const minutesAfterLaunch = (walletFirstSeenMs - pairCreatedAt) / 60_000;
      if (minutesAfterLaunch >= 0 && minutesAfterLaunch <= SNIPER_WINDOW_MINUTES) {
        return "sniper";
      }
    }
  }

  if (pctOfSupply >= WHALE_SUPPLY_PCT_THRESHOLD) return "whale";

  return "unknown";
}

/**
 * Full whale/smart-money analysis for a token: resolves top holders, classifies each wallet,
 * checks for recent buying activity, and persists both the classification and any detected
 * buy events so the reputation system can learn from outcomes over time.
 */
export async function analyzeWallets(
  mintAddress: string,
  context: { creatorAddress?: string | null; pairCreatedAt?: number; priceUsd?: number | null } = {}
): Promise<WalletSignal[]> {
  try {
    const holders = await getTopHolders(mintAddress);
    if (holders.length === 0) return [];

    const ownerAddresses = holders.map((h) => h.ownerAddress).filter((a): a is string => !!a);
    const reputations = await getReputations(ownerAddresses);

    const signals: WalletSignal[] = [];

    for (const holder of holders) {
      if (!holder.ownerAddress) continue;

      const existing = reputations.get(holder.ownerAddress);
      const label = await classifyWallet({
        ownerAddress: holder.ownerAddress,
        pctOfSupply: holder.pctOfSupply,
        creatorAddress: context.creatorAddress,
        pairCreatedAt: context.pairCreatedAt,
        existingLabel: existing?.label,
      });

      // Only bother checking recent activity (extra API calls) for wallets that matter.
      const worthChecking = label !== "unknown" || holder.pctOfSupply >= 1;
      const [isBuying, isSelling] = worthChecking
        ? await Promise.all([
            hasRecentBuy(holder.ownerAddress, mintAddress),
            hasRecentSell(holder.ownerAddress, mintAddress),
          ])
        : [false, false];

      await upsertWalletSeen(holder.ownerAddress, label);

      // Bucket into 10-minute windows so repeated scan cycles observing the same ongoing
      // buy/sell don't create a new duplicate position row every cycle. Real tx signatures
      // from Helius webhooks (Version 2) will replace this synthetic-signature approach.
      const bucket = Math.floor(Date.now() / (10 * 60 * 1000));

      if (isBuying) {
        await recordPosition({
          walletAddress: holder.ownerAddress,
          tokenAddress: mintAddress,
          action: "buy",
          uiAmount: holder.uiAmount,
          priceUsd: context.priceUsd ?? null,
          signature: `buy-${holder.ownerAddress}-${mintAddress}-${bucket}`,
        });
      }
      if (isSelling) {
        await recordPosition({
          walletAddress: holder.ownerAddress,
          tokenAddress: mintAddress,
          action: "sell",
          uiAmount: holder.uiAmount,
          priceUsd: context.priceUsd ?? null,
          signature: `sell-${holder.ownerAddress}-${mintAddress}-${bucket}`,
        });
      }

      signals.push({
        address: holder.ownerAddress,
        label,
        historicalWinRatePct: existing?.historical_win_rate ?? undefined,
        avgHoldDays: existing?.avg_hold_days ?? undefined,
        isBuying,
      });
    }

    return signals
      // Surface the most interesting wallets first: buyers, then by label significance.
      .sort((a, b) => Number(b.isBuying) - Number(a.isBuying));
  } catch (err) {
    logger.error({ err, mintAddress }, "analyzeWallets failed");
    return [];
  }
}
