import cron from "node-cron";
import { env } from "../config/env";
import { logger } from "../utils/logger";
import { discoverCandidateTokens, buildTokenSnapshot } from "./solana/tokenScanner";
import { analyzeSnapshot } from "./scoring/analyze";
import { saveAnalysis } from "./db/postgres";
import { broadcastAlert } from "./telegram/bot";

let isRunning = false;

export async function runScanCycle(): Promise<void> {
  if (isRunning) {
    logger.warn("Previous scan cycle still running, skipping this tick");
    return;
  }
  isRunning = true;
  const startedAt = Date.now();

  try {
    const candidates = await discoverCandidateTokens();
    logger.info({ count: candidates.length }, "scan cycle: candidates discovered");

    for (const address of candidates) {
      try {
        const snapshot = await buildTokenSnapshot(address);
        if (!snapshot) continue;

        const result = analyzeSnapshot(snapshot);
        await saveAnalysis(result);

        if (result.score.total >= env.MIN_ALERT_SCORE && result.risk.riskScore <= env.MAX_ALERT_RISK) {
          await broadcastAlert(result);
          logger.info(
            { token: result.token.symbol, score: result.score.total },
            "alert sent"
          );
        }
      } catch (err) {
        logger.error({ err, address }, "failed to process candidate token");
      }
    }
  } catch (err) {
    logger.error({ err }, "scan cycle failed");
  } finally {
    isRunning = false;
    logger.info({ ms: Date.now() - startedAt }, "scan cycle complete");
  }
}

export function scheduleScanJob(): void {
  const intervalSeconds = env.SCAN_INTERVAL_SECONDS;
  // node-cron needs a cron expression; for sub-minute intervals we use setInterval instead.
  if (intervalSeconds < 60) {
    setInterval(() => void runScanCycle(), intervalSeconds * 1000);
    logger.info({ intervalSeconds }, "scan job scheduled via setInterval");
  } else {
    const minutes = Math.round(intervalSeconds / 60);
    cron.schedule(`*/${minutes} * * * *`, () => void runScanCycle());
    logger.info({ minutes }, "scan job scheduled via cron");
  }
}
