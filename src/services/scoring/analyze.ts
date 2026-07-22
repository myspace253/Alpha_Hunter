import type { AnalysisResult, TokenSnapshot } from "../../types";
import { computeAlphaScore, explainScore } from "./scoringEngine";
import { assessRisk } from "./riskEngine";
import { buildTokenSnapshot } from "../solana/tokenScanner";

export function analyzeSnapshot(token: TokenSnapshot): AnalysisResult {
  const score = computeAlphaScore(token);
  const risk = assessRisk(token);
  const reasons = explainScore(token, score);
  return { token, score, risk, reasons };
}

export async function analyzeTokenByAddress(tokenAddress: string): Promise<AnalysisResult | null> {
  const snapshot = await buildTokenSnapshot(tokenAddress);
  if (!snapshot) return null;
  return analyzeSnapshot(snapshot);
}
