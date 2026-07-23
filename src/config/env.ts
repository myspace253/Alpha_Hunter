import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  SCAN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),

  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_ALERT_CHAT_IDS: z.string().default(""),

  HELIUS_API_KEY: z.string().optional().default(""),
  HELIUS_RPC_URL: z.string().optional().default(""),
  QUICKNODE_RPC_URL: z.string().optional().default(""),
  ALCHEMY_RPC_URL: z.string().optional().default(""),
  SHYFT_API_KEY: z.string().optional().default(""),
  // Max requests/second sent to Helius's enhanced-transactions REST API (getEnhancedTransactions,
  // used for buy/sell detection). Free/dev-tier Helius keys are easy to exceed when analyzing
  // several wallets per token — lower this if you're still seeing 429s.
  HELIUS_RATE_LIMIT_PER_SEC: z.coerce.number().positive().default(2),

  DEXSCREENER_BASE_URL: z.string().default("https://api.dexscreener.com"),
  BIRDEYE_API_KEY: z.string().optional().default(""),
  BIRDEYE_BASE_URL: z.string().default("https://public-api.birdeye.so"),
  // Birdeye's free tier is commonly capped at 1 request/second — check your plan's actual
  // limit (visible in the `X-RateLimit-Limit` response header) and adjust accordingly.
  BIRDEYE_RATE_LIMIT_PER_SEC: z.coerce.number().positive().default(1),
  JUPITER_BASE_URL: z.string().default("https://lite-api.jup.ag"),

  TWITTER_BEARER_TOKEN: z.string().optional().default(""),
  LUNARCRUSH_API_KEY: z.string().optional().default(""),
  CRYPTOPANIC_API_KEY: z.string().optional().default(""),

  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  LLM_PROVIDER: z.string().default("openai"),
  // Base URL for the OpenAI-compatible chat completions API. Point this at a router/proxy
  // (e.g. ZenMux: https://zenmux.ai/api/v1) to swap providers/models without code changes —
  // OPENAI_API_KEY is still sent as the bearer token either way.
  AI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  // Request timeout for LLM calls, in milliseconds. Routers that proxy to slower/reasoning
  // models (or that queue requests) often need much more headroom than a direct OpenAI call —
  // default is generous (10 min) so a slow model doesn't get killed mid-response.
  API_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().optional().default(""),

  MIN_ALERT_SCORE: z.coerce.number().min(0).max(100).default(70),
  MAX_ALERT_RISK: z.coerce.number().min(0).max(100).default(40),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

export const alertChatIds = env.TELEGRAM_ALERT_CHAT_IDS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
