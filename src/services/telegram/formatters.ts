import { Markup } from "telegraf";
import type { AnalysisResult } from "../../types";

function fmtUsd(n?: number): string {
  if (n === undefined || n === null) return "N/A";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

/** Canonical block-explorer / data-provider links for a Solana token mint address. */
export function explorerLinks(address: string) {
  return {
    solscan: `https://solscan.io/token/${address}`,
    birdeye: `https://birdeye.so/token/${address}?chain=solana`,
    dexscreener: `https://dexscreener.com/solana/${address}`,
  };
}

/** Inline keyboard with one tap-to-open button per data source for a single token. */
export function tokenActionKeyboard(address: string) {
  const links = explorerLinks(address);
  return Markup.inlineKeyboard([
    [
      Markup.button.url("📊 Solscan", links.solscan),
      Markup.button.url("🦅 Birdeye", links.birdeye),
      Markup.button.url("📈 DexScreener", links.dexscreener),
    ],
  ]);
}

/** Inline keyboard with one row of explorer links per token, for multi-token list messages. */
export function tokenListKeyboard(rows: Array<{ token_address: string; symbol: string }>) {
  const keyboardRows = rows.map((r) => {
    const links = explorerLinks(r.token_address);
    return [
      Markup.button.url(`${r.symbol} · Solscan`, links.solscan),
      Markup.button.url("Birdeye", links.birdeye),
    ];
  });
  return Markup.inlineKeyboard(keyboardRows);
}

export function formatAlertMessage(result: AnalysisResult): string {
  const { token, score, risk } = result;
  const lines = [
    `🚨 *NEW ALPHA*`,
    ``,
    `*Token:* ${token.symbol} (${token.name})`,
    `*Marketcap:* ${fmtUsd(token.pair.marketCap ?? token.pair.fdv)}`,
    `*Liquidity:* ${fmtUsd(token.pair.liquidity?.usd)}`,
    `*Volume 24h:* ${fmtUsd(token.pair.volume?.h24)}`,
    `*Holders:* ${token.onChain.totalHolders ?? "N/A"}`,
    `*Narrative:* ${token.narrative[0]?.category ?? "N/A"}`,
    ``,
    `*AI Score:* ${score.total}/100`,
    `*Risk:* ${risk.riskLevel} (${risk.riskScore}/100)`,
    `*Expected:* ${score.expectedMultiple}`,
    `*Confidence:* ${score.confidencePct}%`,
    ``,
    `*Contract:*`,
    `\`${token.address}\``,
    `_(tap the address to copy — or use the buttons below)_`,
  ];
  return lines.join("\n");
}

export function formatAnalysisMessage(result: AnalysisResult): string {
  const { token, score, risk, reasons } = result;
  const b = score.breakdown;
  const lines = [
    `📊 *Analysis: ${token.symbol}*`,
    ``,
    `*AI Score:* ${score.total}/100  |  *Risk:* ${risk.riskLevel} (${risk.riskScore}/100)`,
    `*Bullish Probability:* ${score.bullishProbabilityPct}%  |  *Expected:* ${score.expectedMultiple}`,
    ``,
    `*Score Breakdown*`,
    `Liquidity: ${b.liquidityScore.toFixed(0)}  Whale: ${b.whaleScore.toFixed(0)}  Volume: ${b.volumeScore.toFixed(0)}`,
    `Social: ${b.socialScore.toFixed(0)}  Holder: ${b.holderScore.toFixed(0)}  Narrative: ${b.narrativeScore.toFixed(0)}  Dev: ${b.developerScore.toFixed(0)}`,
    ``,
    `*Why:*`,
    ...reasons.map((r) => `• ${r}`),
    ``,
    `*Risk flags:*`,
    ...risk.reasons.map((r) => `• ${r}`),
    ``,
    `*Contract:*`,
    `\`${token.address}\``,
  ];
  return lines.join("\n");
}

interface TokenListRow {
  token_address: string;
  symbol: string;
  ai_score: string;
  risk_level: string;
}

export function formatTokenListMessage(title: string, rows: TokenListRow[]): string {
  if (rows.length === 0) return `${title}\n\nNo data yet — the scanner needs at least one scan cycle.`;
  const lines = [title, "", "_Tap a button below to open a token on Solscan or Birdeye._", ""];
  rows.forEach((r, i) => {
    lines.push(`${i + 1}. *${r.symbol}* — Score: ${r.ai_score} — Risk: ${r.risk_level}`);
    lines.push(`   \`${r.token_address}\``);
  });
  return lines.join("\n");
}
