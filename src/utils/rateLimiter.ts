import type { AxiosError } from "axios";
import { logger } from "./logger";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAxios429(err: unknown): err is AxiosError {
  return (
    typeof err === "object" &&
    err !== null &&
    "isAxiosError" in err &&
    (err as AxiosError).response?.status === 429
  );
}

function retryAfterMs(err: AxiosError): number | null {
  const header = err.response?.headers?.["retry-after"];
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * Retries a request on HTTP 429, honoring the provider's `Retry-After` header when present
 * and falling back to exponential backoff otherwise. Non-429 errors are re-thrown immediately —
 * this is specifically for rate limits, not general request failures.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; label?: string } = {}
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isAxios429(err) || attempt === retries) throw err;

      const wait = retryAfterMs(err) ?? baseDelayMs * 2 ** attempt;
      logger.warn(
        { label: opts.label, attempt: attempt + 1, waitMs: wait },
        "rate limited (429) — retrying after backoff"
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

/**
 * A simple per-key request queue that enforces a minimum interval between calls, so a burst of
 * concurrent requests (e.g. one per wallet, per token, per scan cycle) can't blow past a
 * provider's rate limit before any 429 even comes back.
 */
export class RateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private readonly minIntervalMs: number;

  constructor(requestsPerSecond: number) {
    this.minIntervalMs = Math.max(1, Math.ceil(1000 / Math.max(requestsPerSecond, 0.01)));
  }

  /** Schedules `fn` to run no sooner than `minIntervalMs` after the previously scheduled call. */
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => fn());
    // Chain the next slot regardless of this call's outcome, spaced by minIntervalMs.
    this.queue = run.then(
      () => sleep(this.minIntervalMs),
      () => sleep(this.minIntervalMs)
    );
    return run;
  }
}
