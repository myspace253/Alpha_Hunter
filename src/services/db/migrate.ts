import fs from "node:fs";
import path from "node:path";
import { pool } from "./postgres";
import { logger } from "../../utils/logger";

async function migrate() {
  const sqlPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(sqlPath, "utf-8");
  logger.info("Applying schema.sql ...");
  await pool.query(sql);
  logger.info("Migration complete.");
  await pool.end();
}

migrate().catch((err) => {
  logger.error({ err }, "migration failed");
  process.exit(1);
});
