import { Telegraf } from "telegraf";
import { env, alertChatIds } from "../../config/env";
import { logger } from "../../utils/logger";
import { analyzeTokenByAddress } from "../scoring/analyze";
import { formatAlertMessage, formatAnalysisMessage, formatTokenListMessage } from "./formatters";
import { addToWatchlist, getTopScoredTokens, getWatchlist } from "../db/postgres";
import { getReputation, getTopWalletsByWinRate } from "../wallets/walletReputation";
import { askAssistant } from "../ai/aiAssistant";
import type { AnalysisResult } from "../../types";

/** Loosely matches a Solana base58 address (32-44 chars, excludes 0/O/I/l) inside free text. */
const SOLANA_ADDRESS_REGEX = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

function extractAddressHint(text: string): string | undefined {
  return text.match(SOLANA_ADDRESS_REGEX)?.[0];
}

export const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

bot.start((ctx) =>
  ctx.reply(
    "👋 Welcome to *Solana AI Alpha Hunter*.\n\n" +
      "I scan Solana for tokens with strong on-chain, wallet, and social signals, " +
      "score them with AI, and alert you before they trend.\n\n" +
      "Try /help to see everything I can do.",
    { parse_mode: "Markdown" }
  )
);

bot.help((ctx) =>
  ctx.reply(
    [
      "*Commands*",
      "/new — recently detected tokens",
      "/hot – highest scoring tokens right now",
      "/trending — tokens with rising social/volume signals",
      "/analysis <token_address> — full AI breakdown for a token",
      "/risk <token_address> — risk-only breakdown",
      "/watch <token_address> — add a token to your watchlist",
      "/watchlist — show your watchlist",
      "/whales <token_address> — whale & smart-money wallet activity",
      "/wallet <address> — a wallet's reputation profile (or top wallets if no address given)",
      "/narrative <token_address> — detected narrative tags",
      "/social <token_address> — Twitter mentions, growth, and sentiment",
      "/compare <addr1> <addr2> — compare two tokens",
      "/settings — configure alert thresholds",
      "",
      "💬 Or just ask me anything in plain text — e.g. \"why is this token risky <address>\" or \"who are the best performing wallets right now\" — I'll pull live data to answer.",
    ].join("\n"),
    { parse_mode: "Markdown" }
  )
);

async function replyWithAnalysis(ctx: any, tokenAddress: string, mode: "full" | "risk" = "full") {
  await ctx.sendChatAction("typing");
  const result = await analyzeTokenByAddress(tokenAddress);
  if (!result) {
    await ctx.reply("Could not find market data for that token address. Double-check it's a valid Solana mint.");
    return;
  }
  const message =
    mode === "risk"
      ? `⚠️ *Risk Report: ${result.token.symbol}*\n\nRisk: ${result.risk.riskLevel} (${result.risk.riskScore}/100)\n\n${result.risk.reasons.map((r) => `• ${r}`).join("\n")}`
      : formatAnalysisMessage(result);
  await ctx.reply(message, { parse_mode: "Markdown" });
}

bot.command("analysis", async (ctx) => {
  const address = ctx.message.text.split(" ")[1];
  if (!address) return ctx.reply("Usage: /analysis <token_address>");
  await replyWithAnalysis(ctx, address, "full");
});

bot.command("risk", async (ctx) => {
  const address = ctx.message.text.split(" ")[1];
  if (!address) return ctx.reply("Usage: /risk <token_address>");
  await replyWithAnalysis(ctx, address, "risk");
});

bot.command("narrative", async (ctx) => {
  const address = ctx.message.text.split(" ")[1];
  if (!address) return ctx.reply("Usage: /narrative <token_address>");
  const result = await analyzeTokenByAddress(address);
  if (!result) return ctx.reply("Token not found.");
  const tags = result.token.narrative.map((n) => `• ${n.category} (${Math.round(n.confidence * 100)}% confidence)`);
  await ctx.reply(`*Narrative for ${result.token.symbol}*\n\n${tags.join("\n")}`, { parse_mode: "Markdown" });
});

bot.command("whales", async (ctx) => {
  const address = ctx.message.text.split(" ")[1];
  if (!address) return ctx.reply("Usage: /whales <token_address>");
  const result = await analyzeTokenByAddress(address);
  if (!result) return ctx.reply("Token not found.");
  if (result.token.wallets.length === 0) {
    return ctx.reply("No whale/smart-money wallet data available yet for this token.");
  }
  const lines = result.token.wallets.map(
    (w) => `• ${w.label} \`${w.address.slice(0, 6)}...\` — ${w.isBuying ? "BUYING" : "watching"} — win rate ${w.historicalWinRatePct ?? "N/A"}%`
  );
  await ctx.reply(`*Whale activity: ${result.token.symbol}*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
});

bot.command("compare", async (ctx) => {
  const [, a, b] = ctx.message.text.split(" ");
  if (!a || !b) return ctx.reply("Usage: /compare <token_address_1> <token_address_2>");
  const [ra, rb] = await Promise.all([analyzeTokenByAddress(a), analyzeTokenByAddress(b)]);
  if (!ra || !rb) return ctx.reply("Could not fetch data for one or both tokens.");
  const msg = [
    `*Comparison*`,
    ``,
    `${ra.token.symbol}: Score ${ra.score.total} | Risk ${ra.risk.riskLevel} | ${ra.score.expectedMultiple}`,
    `${rb.token.symbol}: Score ${rb.score.total} | Risk ${rb.risk.riskLevel} | ${rb.score.expectedMultiple}`,
  ].join("\n");
  await ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.command("hot", async (ctx) => {
  const rows = await getTopScoredTokens(10);
  await ctx.reply(formatTokenListMessage("🔥 *Highest AI Score Right Now*", rows), { parse_mode: "Markdown" });
});

bot.command("trending", async (ctx) => {
  const rows = await getTopScoredTokens(10);
  await ctx.reply(formatTokenListMessage("📈 *Trending*", rows), { parse_mode: "Markdown" });
});

bot.command("new", async (ctx) => {
  const rows = await getTopScoredTokens(10);
  await ctx.reply(formatTokenListMessage("🆕 *Recently Scanned Tokens*", rows), { parse_mode: "Markdown" });
});

bot.command("watch", async (ctx) => {
  const address = ctx.message.text.split(" ")[1];
  if (!address) return ctx.reply("Usage: /watch <token_address>");
  const result = await analyzeTokenByAddress(address);
  if (!result) return ctx.reply("Token not found.");
  await addToWatchlist(String(ctx.chat.id), address, result.token.symbol);
  await ctx.reply(`✅ Added ${result.token.symbol} to your watchlist. I'll alert you on whale buys or liquidity spikes.`);
});

bot.command("watchlist", async (ctx) => {
  const rows = await getWatchlist(String(ctx.chat.id));
  if (rows.length === 0) return ctx.reply("Your watchlist is empty. Use /watch <token_address> to add one.");
  const lines = rows.map((r: any) => `• ${r.symbol} — \`${r.token_address}\``);
  await ctx.reply(`*Your Watchlist*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
});

bot.command("wallet", async (ctx) => {
  const address = ctx.message.text.split(" ")[1];

  if (!address) {
    const top = await getTopWalletsByWinRate(10);
    if (top.length === 0) {
      return ctx.reply(
        "No wallet track records yet — reputation builds up as I observe buy→sell outcomes over time.\n\nUsage: /wallet <address> to look up a specific wallet."
      );
    }
    const lines = top.map(
      (w: any, i: number) =>
        `${i + 1}. \`${w.wallet_address.slice(0, 6)}...\` — ${w.label} — win rate ${Number(w.historical_win_rate).toFixed(0)}% (${w.total_trades} trades)`
    );
    return ctx.reply(`🏆 *Top Wallets by Win Rate*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  }

  const rep = await getReputation(address);
  if (!rep) {
    return ctx.reply("I haven't seen this wallet in any scanned token yet.");
  }
  const lines = [
    `*Wallet Profile*`,
    `\`${rep.wallet_address}\``,
    ``,
    `Label: ${rep.label}`,
    `Win rate: ${rep.historical_win_rate !== null ? `${Number(rep.historical_win_rate).toFixed(0)}%` : "N/A (not enough closed trades yet)"}`,
    `Avg hold: ${rep.avg_hold_days !== null ? `${Number(rep.avg_hold_days).toFixed(1)} days` : "N/A"}`,
    `Total tracked trades: ${rep.total_trades}`,
    `Avg profit per trade: ${rep.total_profit_pct !== null ? `${Number(rep.total_profit_pct).toFixed(1)}%` : "N/A"}`,
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

bot.command("social", async (ctx) => {
  const address = ctx.message.text.split(" ")[1];
  if (!address) return ctx.reply("Usage: /social <token_address>");
  const result = await analyzeTokenByAddress(address);
  if (!result) return ctx.reply("Token not found.");
  const s = result.token.social;
  const lines = [
    `*Social Signals: ${result.token.symbol}*`,
    ``,
    `Trending: ${s.trending ? "🔥 Yes" : "No"}`,
    `Mentions (24h, tracked): ${s.twitterMentions24h ?? "N/A"}`,
    `Mention growth (24h vs prior 24h): ${s.twitterMentionGrowthPct !== undefined ? `${s.twitterMentionGrowthPct.toFixed(0)}%` : "N/A (not enough history yet)"}`,
    `Sentiment: ${s.sentimentScore !== undefined ? (s.sentimentScore > 0.15 ? "🟢 Bullish" : s.sentimentScore < -0.15 ? "🔴 Bearish" : "🟡 Neutral") + ` (${s.sentimentScore.toFixed(2)})` : "N/A"}`,
    ``,
    `_Mention growth is computed from this bot's own tracked history — it builds up accuracy the longer a token has been scanned._`,
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

bot.command("ask", async (ctx) => {
  const question = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!question) return ctx.reply("Usage: /ask <your question>, e.g. /ask why is this token risky <address>");
  await ctx.sendChatAction("typing");
  const { answer } = await askAssistant(question, {
    chatId: String(ctx.chat.id),
    tokenAddressHint: extractAddressHint(question),
  });
  await ctx.reply(answer, { parse_mode: "Markdown" });
});

bot.command("settings", async (ctx) => {
  await ctx.reply(
    `*Current Alert Thresholds*\n\nMin AI Score: ${env.MIN_ALERT_SCORE}\nMax Risk: ${env.MAX_ALERT_RISK}\n\n` +
      `Edit MIN_ALERT_SCORE / MAX_ALERT_RISK in your .env to change these.`,
    { parse_mode: "Markdown" }
  );
});

/**
 * Any text message that didn't match a slash command above falls through to here.
 * Telegraf's middleware chain only reaches this handler for unmatched messages, so this
 * safely coexists with all the /commands registered earlier.
 */
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text || text.startsWith("/")) return; // unrecognized command — don't treat as a question

  await ctx.sendChatAction("typing");
  const { answer } = await askAssistant(text, {
    chatId: String(ctx.chat.id),
    tokenAddressHint: extractAddressHint(text),
  });
  await ctx.reply(answer, { parse_mode: "Markdown" });
});

/** Broadcasts a formatted alert to all configured alert chat IDs. */
export async function broadcastAlert(result: AnalysisResult) {
  const message = formatAlertMessage(result);
  for (const chatId of alertChatIds) {
    try {
      await bot.telegram.sendMessage(chatId, message, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err, chatId }, "failed to send telegram alert");
    }
  }
}

export function launchBot() {
  bot.launch();
  logger.info("Telegram bot launched");
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
