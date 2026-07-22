import { pool } from "../db/postgres";
import { logger } from "../../utils/logger";
import type { NarrativeTag } from "../../types";

/**
 * In-memory momentum cache: category -> 0..1 score, where 1 means "mention count roughly
 * doubled or more vs the prior window" and 0 means flat/declining. Read synchronously by
 * scoringEngine.computeNarrativeScore(); refreshed periodically by refreshNarrativeMomentum().
 *
 * Kept in-memory (rather than re-querying Postgres per token, per scan cycle) because scoring
 * runs synchronously today and momentum only needs to update every few minutes, not per-token.
 */
let momentumCache = new Map<NarrativeTag["category"], number>();
let lastRefreshedAt: Date | null = null;

export function getNarrativeMomentum(category: NarrativeTag["category"]): number {
  return momentumCache.get(category) ?? 0;
}

export function getMomentumCacheStatus() {
  return { lastRefreshedAt, categories: Array.from(momentumCache.entries()) };
}

/**
 * Compares how often each narrative category showed up in scanned tokens over the last 24h
 * vs. the preceding 24h, using `token_analysis.narrative` (the top tag saved per scan) as the
 * signal. A rising count -> higher momentum -> a bump in Narrative Score for matching tokens.
 * This is the "Early Narrative Detection" mechanic from the original spec, grounded in actual
 * scan history instead of a static hardcoded list.
 */
export async function refreshNarrativeMomentum(): Promise<void> {
  try {
    const { rows } = await pool.query<{ narrative: string; window_label: "recent" | "prior"; count: string }>(
      `SELECT
         narrative,
         CASE WHEN created_at > now() - interval '24 hours' THEN 'recent' ELSE 'prior' END AS window_label,
         count(*) AS count
       FROM token_analysis
       WHERE narrative IS NOT NULL
         AND created_at > now() - interval '48 hours'
       GROUP BY narrative, window_label`
    );

    const recentCounts = new Map<string, number>();
    const priorCounts = new Map<string, number>();

    for (const row of rows) {
      const target = row.window_label === "recent" ? recentCounts : priorCounts;
      target.set(row.narrative, Number(row.count));
    }

    const next = new Map<NarrativeTag["category"], number>();
    const categories = new Set([...recentCounts.keys(), ...priorCounts.keys()]);

    for (const category of categories) {
      const recent = recentCounts.get(category) ?? 0;
      const prior = priorCounts.get(category) ?? 0;
      let momentum: number;

      if (prior === 0 && recent > 0) {
        momentum = 1; // brand-new narrative appearing — treat as maximum momentum
      } else if (prior === 0) {
        momentum = 0;
      } else {
        const growth = (recent - prior) / prior; // e.g. +1.0 = doubled
        momentum = Math.max(0, Math.min(1, growth)); // clamp 0..1
      }

      next.set(category as NarrativeTag["category"], momentum);
    }

    momentumCache = next;
    lastRefreshedAt = new Date();
    logger.info({ categories: Object.fromEntries(next) }, "narrative momentum refreshed");
  } catch (err) {
    logger.error({ err }, "refreshNarrativeMomentum failed — keeping previous momentum cache");
  }
}

export function scheduleNarrativeMomentumJob(intervalMs = 15 * 60 * 1000): void {
  void refreshNarrativeMomentum();
  setInterval(() => void refreshNarrativeMomentum(), intervalMs);
}
