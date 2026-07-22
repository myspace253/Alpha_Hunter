import type { NarrativeTag } from "../../types";

/**
 * MVP narrative classifier based on keyword matching against token name/symbol/description.
 * For Version 2/3, replace this with a Sentence-Transformers embedding classifier or an
 * LLM call (see aiAssistant.ts) that compares against a labeled corpus of past narratives.
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

export function classifyNarrative(text: string): NarrativeTag[] {
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
