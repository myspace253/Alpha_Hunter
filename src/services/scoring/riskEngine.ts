import type { RiskAssessment, RiskFlags, TokenSnapshot } from "../../types";

/**
 * Rule-based risk engine (MVP). Each flag adds weighted risk points.
 * For Version 3, replace/augment with a trained classifier (e.g. gradient-boosted trees)
 * over a labeled dataset of confirmed rugpulls vs. legitimate launches.
 */
const RISK_WEIGHTS: Record<keyof RiskFlags, number> = {
  rugpullRisk: 30,
  honeypotRisk: 30,
  bundledSupply: 15,
  fakeVolumeSuspected: 15,
  mintAuthorityActive: 20,
  freezeAuthorityActive: 15,
  lpNotBurned: 20,
  topHolderConcentrationHigh: 20,
};

export function assessRisk(token: TokenSnapshot): RiskAssessment {
  const reasons: string[] = [];

  const mintAuthorityActive = token.onChain.mintAuthorityRevoked === false;
  const freezeAuthorityActive = token.onChain.freezeAuthorityRevoked === false;
  const topHolderConcentrationHigh = (token.onChain.topHolderPct ?? 0) > 20;

  const liquidityUsd = token.pair.liquidity?.usd ?? 0;
  const volume24h = token.pair.volume?.h24 ?? 0;
  // Extremely high volume relative to liquidity can indicate wash trading.
  const fakeVolumeSuspected = liquidityUsd > 0 && volume24h / liquidityUsd > 50;

  const lpNotBurned = liquidityUsd > 0 && token.onChain.lpBurned === false;

  const flags: RiskFlags = {
    rugpullRisk: mintAuthorityActive && lpNotBurned,
    honeypotRisk: false, // requires simulated sell-tx check — wire up via RPC simulation
    bundledSupply: topHolderConcentrationHigh && (token.onChain.creatorWalletAgeDays ?? 999) < 3,
    fakeVolumeSuspected,
    mintAuthorityActive,
    freezeAuthorityActive,
    lpNotBurned,
    topHolderConcentrationHigh,
  };

  let riskScore = 0;
  for (const [flag, isActive] of Object.entries(flags) as Array<[keyof RiskFlags, boolean]>) {
    if (isActive) {
      riskScore += RISK_WEIGHTS[flag];
    }
  }
  riskScore = Math.min(100, riskScore);

  if (flags.mintAuthorityActive) reasons.push("Mint authority is still active (supply can be inflated)");
  if (flags.freezeAuthorityActive) reasons.push("Freeze authority is still active (accounts can be frozen)");
  if (flags.lpNotBurned) reasons.push("Liquidity pool tokens do not appear to be burned/locked");
  if (flags.topHolderConcentrationHigh)
    reasons.push(`Top holder concentration is high (${token.onChain.topHolderPct?.toFixed(1)}%)`);
  if (flags.fakeVolumeSuspected) reasons.push("24h volume is unusually high relative to liquidity");
  if (flags.bundledSupply) reasons.push("Holder distribution pattern resembles a bundled/sniped launch");
  if (reasons.length === 0) reasons.push("No major red flags detected in available data");

  let riskLevel: RiskAssessment["riskLevel"] = "Low";
  if (riskScore >= 70) riskLevel = "Critical";
  else if (riskScore >= 45) riskLevel = "High";
  else if (riskScore >= 20) riskLevel = "Medium";

  return { riskScore, riskLevel, flags, reasons };
}
