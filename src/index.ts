import { logger } from "./utils/logger";
import { launchBot } from "./services/telegram/bot";
import { scheduleScanJob, runScanCycle } from "./services/scanJob";
import { pool } from "./services/db/postgres";
import { updateWalletReputations } from "./services/wallets/reputationUpdater";

const REPUTATION_UPDATE_INTERVAL_MS = 60 * 60 * 1000; // hourly

async function main() {
  logger.info("Starting Solana AI Alpha Hunter...");

  // Fail fast if the database is unreachable.
  try {
    await pool.query("SELECT 1");
    logger.info("Database connection OK");
  } catch (err) {
    logger.error({ err }, "Database connection failed — run `npm run migrate` and check DATABASE_URL");
    process.exit(1);
  }

  launchBot();
  scheduleScanJob();

  // Kick off an initial scan immediately rather than waiting for the first interval tick.
  void runScanCycle();

  // Wallet reputation is recomputed hourly from closed (buy→sell) positions.
  void updateWalletReputations();
  setInterval(() => void updateWalletReputations(), REPUTATION_UPDATE_INTERVAL_MS);

  logger.info("Solana AI Alpha Hunter is running.");
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
