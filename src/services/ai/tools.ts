import type { ToolDefinition } from "./llmClient";
import { analyzeTokenByAddress } from "../scoring/analyze";
import { getReputation, getTopWalletsByWinRate } from "../wallets/walletReputation";
import { getTopScoredTokens, getWatchlist } from "../db/postgres";
import { getMomentumCacheStatus } from "../scoring/narrativeTrends";

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "analyze_token",
      description:
        "Get the full AI score, risk assessment, and plain-language reasons for a Solana token by its mint address. Use this whenever the user asks about a specific token's quality, risk, or 'why is this good/bad'.",
      parameters: {
        type: "object",
        properties: {
          token_address: { type: "string", description: "The Solana token mint address" },
        },
        required: ["token_address"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_wallet_reputation",
      description:
        "Look up a wallet's historical track record — win rate, average hold time, average profit per trade, and its classification (whale, smart_money, sniper, etc). Use this when the user asks about a specific wallet address.",
      parameters: {
        type: "object",
        properties: {
          wallet_address: { type: "string", description: "The Solana wallet address" },
        },
        required: ["wallet_address"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_top_wallets",
      description: "Get the current leaderboard of wallets with the best win rates across tracked trades.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_top_tokens",
      description: "Get the highest AI-scored tokens from the most recent scan cycles.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many tokens to return, default 10" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_narrative_momentum",
      description:
        "Get which narrative categories (Meme, Agent, DePIN, Gaming, RWA, DeFi, Consumer Crypto) are currently trending up or cooling down, based on real scan-frequency growth over the last 24h.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_watchlist",
      description: "Get the current chat's saved token watchlist.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_social_signals",
      description:
        "Get Twitter/X mention counts, mention growth, and sentiment for a specific token. Use this when the user asks if a token is 'trending', 'hyped', or about social sentiment.",
      parameters: {
        type: "object",
        properties: {
          token_address: { type: "string", description: "The Solana token mint address" },
        },
        required: ["token_address"],
      },
    },
  },
];

/**
 * Executes a tool call by name. `chatId` is injected by the caller (not exposed to the model)
 * so the agent can't be prompted into reading another chat's watchlist.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { chatId: string }
): Promise<unknown> {
  switch (name) {
    case "analyze_token": {
      const address = String(args.token_address ?? "");
      const result = await analyzeTokenByAddress(address);
      if (!result) return { error: "No market data found for that token address." };
      return {
        symbol: result.token.symbol,
        name: result.token.name,
        ai_score: result.score.total,
        bullish_probability_pct: result.score.bullishProbabilityPct,
        expected_multiple: result.score.expectedMultiple,
        confidence_pct: result.score.confidencePct,
        score_breakdown: result.score.breakdown,
        risk_score: result.risk.riskScore,
        risk_level: result.risk.riskLevel,
        risk_reasons: result.risk.reasons,
        positive_reasons: result.reasons,
        liquidity_usd: result.token.pair.liquidity?.usd ?? null,
        volume_24h_usd: result.token.pair.volume?.h24 ?? null,
        holders: result.token.onChain.totalHolders ?? null,
        narrative: result.token.narrative,
      };
    }

    case "get_wallet_reputation": {
      const address = String(args.wallet_address ?? "");
      const rep = await getReputation(address);
      if (!rep) return { error: "No history found for this wallet yet." };
      return rep;
    }

    case "get_top_wallets": {
      return getTopWalletsByWinRate(10);
    }

    case "get_top_tokens": {
      const limit = typeof args.limit === "number" ? args.limit : 10;
      return getTopScoredTokens(limit);
    }

    case "get_narrative_momentum": {
      return getMomentumCacheStatus();
    }

    case "get_social_signals": {
      const address = String(args.token_address ?? "");
      const result = await analyzeTokenByAddress(address);
      if (!result) return { error: "No market data found for that token address." };
      return { symbol: result.token.symbol, ...result.token.social };
    }

    case "get_watchlist": {
      return getWatchlist(ctx.chatId);
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
