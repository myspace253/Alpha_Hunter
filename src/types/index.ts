export interface TokenPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  priceChange?: { h24?: number; h6?: number; h1?: number; m5?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  url?: string;
}

export interface OnChainMetrics {
  totalHolders?: number;
  holderGrowthPct24h?: number;
  topHolderPct?: number;
  mintAuthorityRevoked?: boolean;
  freezeAuthorityRevoked?: boolean;
  lpBurned?: boolean;
  creatorWalletAgeDays?: number;
}

export interface WalletSignal {
  address: string;
  label: "whale" | "smart_money" | "vc" | "sniper" | "insider" | "developer" | "unknown";
  historicalWinRatePct?: number;
  avgHoldDays?: number;
  isBuying: boolean;
}

export interface SocialMetrics {
  twitterMentions24h?: number;
  twitterMentionGrowthPct?: number;
  telegramMemberGrowthPct?: number;
  sentimentScore?: number; // -1 (bearish) to 1 (bullish)
  trending: boolean;
}

export interface NarrativeTag {
  category: "DePIN" | "Gaming" | "Meme" | "RWA" | "DeFi" | "Agent" | "Consumer Crypto" | "Other";
  confidence: number; // 0-1
}

export interface RiskFlags {
  rugpullRisk: boolean;
  honeypotRisk: boolean;
  bundledSupply: boolean;
  fakeVolumeSuspected: boolean;
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
  lpNotBurned: boolean;
  topHolderConcentrationHigh: boolean;
}

export interface TokenSnapshot {
  address: string;
  symbol: string;
  name: string;
  pair: TokenPair;
  onChain: OnChainMetrics;
  wallets: WalletSignal[];
  social: SocialMetrics;
  narrative: NarrativeTag[];
  collectedAt: string; // ISO timestamp
}

export interface ScoreBreakdown {
  liquidityScore: number; // 0-100, weight 25%
  whaleScore: number; // 0-100, weight 20%
  volumeScore: number; // 0-100, weight 15%
  socialScore: number; // 0-100, weight 15%
  holderScore: number; // 0-100, weight 10%
  narrativeScore: number; // 0-100, weight 10%
  developerScore: number; // 0-100, weight 5%
}

export interface AlphaScore {
  total: number; // 0-100 weighted composite
  breakdown: ScoreBreakdown;
  bullishProbabilityPct: number;
  expectedMultiple: string; // e.g. "5-10x"
  confidencePct: number;
}

export interface RiskAssessment {
  riskScore: number; // 0-100, higher = riskier
  riskLevel: "Low" | "Medium" | "High" | "Critical";
  flags: RiskFlags;
  reasons: string[];
}

export interface AnalysisResult {
  token: TokenSnapshot;
  score: AlphaScore;
  risk: RiskAssessment;
  reasons: string[]; // human-readable explanation bullets ("Explainable AI")
}
