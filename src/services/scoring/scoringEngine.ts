import type { AlphaScore, ScoreBreakdown, TokenSnapshot } from "../../types";
import { assessRisk } from "./riskEngine";
import { getNarrativeMomentum } from "./narrativeTrends";

/**
 * Weights match the spec's "AI Score" breakdown:
 * Liquidity 25%, Whale 20%, Volume 15%, Social 15%, Holder 10%, Narrative 10%, Developer 5%
 */
const WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  liquidityScore: 0.25,
  whaleScore: 0.2,
  volumeScore: 0.15,
  socialScore: 0.15,
  holderScore: 0.1,
  narrativeScore: 0.1,
  developerScore: 0.05,
};

/** Clamp a raw value to 0-100 given a soft target ceiling (value >= target => 100). */
function normalize(value: number, target: number): number {
  if (target <= 0) return 0;
  return Math.max(0, Math.min(100, (value / target) * 100));
}

function computeLiquidityScore(token: TokenSnapshot): number {
  const liquidity = token.pair.liquidity?.usd ?? 0;
  // $100k+ liquidity is treated as a strong signal for an MVP-stage token.
  return normalize(liquidity, 100_000);
}

function computeWhaleScore(token: TokenSnapshot): number {
  if (token.wallets.length === 0) return 30; // neutral-low default when no wallet data available
  const buyingSmartMoney = token.wallets.filter(
    (w) => w.isBuying && (w.label === "smart_money" || w.label === "whale" || w.label === "vc")
  );
  if (buyingSmartMoney.length === 0) return 20;
  const avgWinRate =
    buyingSmartMoney.reduce((sum, w) => sum + (w.historicalWinRatePct ?? 50), 0) / buyingSmartMoney.length;
  return normalize(buyingSmartMoney.length * 20 + avgWinRate, 150);
}

function computeVolumeScore(token: TokenSnapshot): number {
  const volume24h = token.pair.volume?.h24 ?? 0;
  return normalize(volume24h, 500_000);
}

function computeSocialScore(token: TokenSnapshot): number {
  const { twitterMentionGrowthPct = 0, telegramMemberGrowthPct = 0, sentimentScore = 0, trending } =
    token.social;
  let score = normalize(twitterMentionGrowthPct, 200) * 0.4 + normalize(telegramMemberGrowthPct, 200) * 0.3;
  score += ((sentimentScore + 1) / 2) * 100 * 0.2;
  score += trending ? 10 : 0;
  return Math.max(0, Math.min(100, score));
}

function computeHolderScore(token: TokenSnapshot): number {
  const holders = token.onChain.totalHolders ?? 0;
  return normalize(holders, 3000);
}

function computeNarrativeScore(token: TokenSnapshot): number {
  if (token.narrative.length === 0) return 30;
  const top = token.narrative[0];
  const base = top.confidence * 100;
  // Momentum (0..1) reflects how much this narrative's scan-frequency has grown in the last
  // 24h vs the prior 24h — see narrativeTrends.ts. A rising narrative earns up to +25 points.
  const momentum = getNarrativeMomentum(top.category);
  return Math.min(100, base + momentum * 25);
}

function computeDeveloperScore(token: TokenSnapshot): number {
  // Placeholder — wire up GitHub repo/commit/contributor lookups for AI-narrative tokens.
  return 40;
}

export function computeAlphaScore(token: TokenSnapshot): AlphaScore {
  const breakdown: ScoreBreakdown = {
    liquidityScore: computeLiquidityScore(token),
    whaleScore: computeWhaleScore(token),
    volumeScore: computeVolumeScore(token),
    socialScore: computeSocialScore(token),
    holderScore: computeHolderScore(token),
    narrativeScore: computeNarrativeScore(token),
    developerScore: computeDeveloperScore(token),
  };

  const total = (Object.keys(breakdown) as Array<keyof ScoreBreakdown>).reduce(
    (sum, key) => sum + breakdown[key] * WEIGHTS[key],
    0
  );

  const risk = assessRisk(token);
  // Bullish probability leans on the composite score, discounted by risk.
  const bullishProbabilityPct = Math.max(0, Math.round(total * (1 - risk.riskScore / 200)));

  let expectedMultiple = "1-2x";
  if (total >= 90) expectedMultiple = "10-50x";
  else if (total >= 80) expectedMultiple = "5-10x";
  else if (total >= 65) expectedMultiple = "2-5x";
  else if (total >= 50) expectedMultiple = "1-2x";
  else expectedMultiple = "0-1x (weak signal)";

  const confidencePct = Math.round(
    Math.min(100, total * 0.6 + (100 - risk.riskScore) * 0.4)
  );

  return {
    total: Math.round(total),
    breakdown,
    bullishProbabilityPct,
    expectedMultiple,
    confidencePct,
  };
}

export function explainScore(token: TokenSnapshot, score: AlphaScore): string[] {
  const reasons: string[] = [];
  const b = score.breakdown;

  if (b.liquidityScore >= 60) reasons.push(`Liquidity is healthy ($${(token.pair.liquidity?.usd ?? 0).toLocaleString()})`);
  if (b.whaleScore >= 60) reasons.push("Whale / smart-money wallets are accumulating");
  if (b.volumeScore >= 60) reasons.push(`24h volume is strong ($${(token.pair.volume?.h24 ?? 0).toLocaleString()})`);
  if (b.socialScore >= 60) reasons.push("Social mentions and sentiment are trending upward");
  if (b.holderScore >= 60) reasons.push(`Holder base is growing (${token.onChain.totalHolders ?? "?"} holders)`);
  if (b.narrativeScore >= 60 && token.narrative[0])
    reasons.push(`Narrative "${token.narrative[0].category}" is currently in favor`);
  if (token.onChain.mintAuthorityRevoked) reasons.push("Mint authority has been revoked");
  if (token.onChain.freezeAuthorityRevoked) reasons.push("Freeze authority has been revoked");

  if (reasons.length === 0) reasons.push("Signals are mixed or below threshold — proceed with caution");
  return reasons;
}
