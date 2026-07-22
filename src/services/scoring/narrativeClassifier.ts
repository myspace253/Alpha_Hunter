import type { NarrativeTag } from "../../types";
import { pool } from "../db/postgres";
import { logger } from "../../utils/logger";
import { completeJson } from "../ai/llmClient";

const ALLOWED_CATEGORIES: NarrativeTag["category"][] = [
  "DePIN",
  "Gaming",
  "Meme",
  "RWA",
  "DeFi",
  "Agent",
  "Consumer Crypto",
  "Other",
];

// Cache LLM classifications for a day — narratives don't change token-to-token minute-to-minute,
// and this is the single biggest lever for keeping OpenAI cost predictable at scan-loop scale.
const CACHE_TTL_HOURS = 24;

export interface NarrativeContext {
  tokenAddress: string;
  name: string;
  symbol: string;
  /** Optional extra context: DexScreener pair description/socials, trending flag, etc. */
  extra?: string;
}

/**
 * MVP fallback classifier based on keyword matching against token name/symbol.
 * Used when no OPENAI_API_KEY is configured, or when the LLM call fails, so narrative
 * scoring never silently goes to zero.
 */
const NARRATIVE_KEYWORDS: Record<NarrativeTag["category"], string[]> = {
  DePIN: ["depin", "wireless", "sensor", "compute network", "bandwidth", "iot"],
  Gaming: ["game", "gaming", "play", "quest", "guild", "arena", "rpg"],
  Meme: ["dog", "cat", "pepe", "inu", "meme", "wojak", "frog", "elon"],
  RWA: ["rwa", "real world asset", "treasury", "bond", "tokenized"],
  DeFi: ["swap", "yield", "lend", "stake", "vault", "amm", "perp"],
  Agent: ["agent", "ai agent", "autonomous", "assistant"],
  "Consumer Crypto": ["social", "app", "consumer", "wallet", "payments"],
  Other: [],
};

export function classifyNarrativeKeyword(text: string): NarrativeTag[] {
  const lower = text.toLowerCase();
  const matches: NarrativeTag[] = [];

  for (const [category, keywords] of Object.entries(NARRATIVE_KEYWORDS) as Array<
    [NarrativeTag["category"], string[]]
  >) {
    if (category === "Other") continue;
    const hits = keywords.filter((kw) => lower.includes(kw)).length;
    if (hits > 0) {
      matches.push({ category, confidence: Math.min(1, hits / keywords.length + 0.3) });
    }
  }

  if (matches.length === 0) {
    matches.push({ category: "Other", confidence: 0.3 });
  }

  return matches.sort((a, b) => b.confidence - a.confidence);
}

function validateAndClamp(raw: unknown): NarrativeTag[] | null {
  if (!Array.isArray(raw)) return null;
  const tags: NarrativeTag[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const category = (item as { category?: unknown }).category;
    const confidence = (item as { confidence?: unknown }).confidence;
    if (typeof category !== "string" || !ALLOWED_CATEGORIES.includes(category as NarrativeTag["category"])) {
      continue;
    }
    const conf = typeof confidence === "number" ? confidence : Number(confidence);
    if (Number.isNaN(conf)) continue;
    tags.push({ category: category as NarrativeTag["category"], confidence: Math.max(0, Math.min(1, conf)) });
  }

  if (tags.length === 0) return null;
  return tags.sort((a, b) => b.confidence - a.confidence);
}

async function classifyWithLLM(ctx: NarrativeContext): Promise<{ tags: NarrativeTag[]; model: string } | null> {
  const system =
    "You classify Solana crypto tokens into narrative categories for a trading signal bot. " +
    `Allowed categories (use ONLY these, exact spelling): ${ALLOWED_CATEGORIES.join(", ")}. ` +
    "A token can match more than one category. Respond ONLY with JSON in this exact shape: " +
    '{"narratives":[{"category":"Agent","confidence":0.85}]}. ' +
    "confidence is 0-1. Do not include any text outside the JSON object. " +
    'If genuinely unclassifiable, return a single entry with category "Other" and low confidence. ' +
    "Do not invent facts about the token; base the classification only on the name, symbol, and context given.";

  const user = [
    `Name: ${ctx.name}`,
    `Symbol: ${ctx.symbol}`,
    ctx.extra ? `Context: ${ctx.extra}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await completeJson({ system, user, maxTokens: 200 });
  if (!raw) return null;

  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const tags = validateAndClamp(parsed.narratives);
    if (!tags) return null;
    return { tags, model: "openai" };
  } catch (err) {
    logger.warn({ err, raw }, "narrativeClassifier: failed to parse LLM response, falling back");
    return null;
  }
}

async function getCached(tokenAddress: string): Promise<NarrativeTag[] | null> {
  const { rows } = await pool.query(
    `SELECT narrative FROM narrative_cache
     WHERE token_address = $1 AND created_at > now() - interval '${CACHE_TTL_HOURS} hours'`,
    [tokenAddress]
  );
  return rows[0]?.narrative ?? null;
}

async function saveCache(tokenAddress: string, tags: NarrativeTag[], source: "llm" | "keyword", model?: string) {
  await pool.query(
    `INSERT INTO narrative_cache (token_address, narrative, source, model, created_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (token_address) DO UPDATE SET
       narrative = EXCLUDED.narrative,
       source = EXCLUDED.source,
       model = EXCLUDED.model,
       created_at = now()`,
    [tokenAddress, JSON.stringify(tags), source, model ?? null]
  );
}

/**
 * Main entry point: returns narrative tags for a token, preferring a fresh LLM classification,
 * cached in Postgres for CACHE_TTL_HOURS, and falling back to keyword matching if no LLM is
 * configured or the call fails for any reason (network, parsing, rate limit).
 */
export async function classifyNarrative(ctx: NarrativeContext): Promise<NarrativeTag[]> {
  try {
    const cached = await getCached(ctx.tokenAddress);
    if (cached) return cached;
  } catch (err) {
    logger.error({ err }, "narrativeClassifier: cache lookup failed, continuing without cache");
  }

  const llmResult = await classifyWithLLM(ctx);
  if (llmResult) {
    try {
      await saveCache(ctx.tokenAddress, llmResult.tags, "llm", llmResult.model);
    } catch (err) {
      logger.error({ err }, "narrativeClassifier: failed to cache LLM result");
    }
    return llmResult.tags;
  }

  // Fallback: keyword classifier. Still cached so we don't hammer the LLM provider (or retry
  // an unconfigured LLM) on every scan cycle for the same token.
  const fallbackTags = classifyNarrativeKeyword(`${ctx.name} ${ctx.symbol} ${ctx.extra ?? ""}`);
  try {
    await saveCache(ctx.tokenAddress, fallbackTags, "keyword");
  } catch (err) {
    logger.error({ err }, "narrativeClassifier: failed to cache keyword fallback result");
  }
  return fallbackTags;
}
