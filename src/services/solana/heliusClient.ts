import axios from "axios";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";
import { RateLimiter, withRateLimitRetry } from "../../utils/rateLimiter";

const rpcUrl = env.HELIUS_RPC_URL || undefined;

function requireRpc(): boolean {
  if (!rpcUrl) {
    logger.warn("HELIUS_RPC_URL not set — Solana RPC calls will be skipped");
    return false;
  }
  return true;
}

async function rpcCall<T = unknown>(method: string, params: unknown[]): Promise<T | null> {
  if (!requireRpc()) return null;
  try {
    const { data } = await withRateLimitRetry(
      () =>
        axios.post(rpcUrl as string, {
          jsonrpc: "2.0",
          id: "alpha-hunter",
          method,
          params,
        }),
      { label: `helius.rpc.${method}`, retries: 2 }
    );
    if (data.error) {
      logger.error({ error: data.error, method }, "helius rpc error");
      return null;
    }
    return data.result as T;
  } catch (err) {
    logger.error({ err, method }, "helius rpc call failed");
    return null;
  }
}

/** Returns the largest token holders for a given mint. Used for concentration/whale checks. */
export async function getTokenLargestAccounts(mintAddress: string) {
  return rpcCall<{ value: Array<{ address: string; amount: string; uiAmount: number }> }>(
    "getTokenLargestAccounts",
    [mintAddress]
  );
}

/** Returns the supply info for a mint, including decimals and total supply. */
export async function getTokenSupply(mintAddress: string) {
  return rpcCall<{ value: { amount: string; decimals: number; uiAmount: number } }>("getTokenSupply", [
    mintAddress,
  ]);
}

/** Returns account info for a mint — used to check mint/freeze authority status. */
export async function getAccountInfo(address: string) {
  return rpcCall<{ value: unknown }>("getAccountInfo", [address, { encoding: "jsonParsed" }]);
}

interface ParsedTokenAccountInfo {
  value: {
    data?: {
      parsed?: {
        info?: {
          owner?: string;
          mint?: string;
          tokenAmount?: { uiAmount: number; amount: string; decimals: number };
        };
      };
    };
  } | null;
}

/**
 * `getTokenLargestAccounts` returns *token account* addresses, not wallet owners.
 * This resolves a token account to its owning wallet address via jsonParsed account info.
 */
export async function resolveTokenAccountOwner(tokenAccountAddress: string): Promise<string | null> {
  const result = await rpcCall<ParsedTokenAccountInfo>("getAccountInfo", [
    tokenAccountAddress,
    { encoding: "jsonParsed" },
  ]);
  return result?.value?.data?.parsed?.info?.owner ?? null;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

/**
 * Returns transaction signatures for an address, newest-first. Supports pagination via `before`.
 * Used to approximate wallet/token age by walking back to the earliest signature.
 */
export async function getSignaturesForAddress(
  address: string,
  options: { limit?: number; before?: string } = {}
): Promise<SignatureInfo[]> {
  const result = await rpcCall<SignatureInfo[]>("getSignaturesForAddress", [
    address,
    { limit: options.limit ?? 1000, before: options.before },
  ]);
  return result ?? [];
}

/**
 * Walks backward through an address's signature history (capped at `maxPages`) to estimate
 * its earliest known activity. This is a heuristic, not a guarantee of true wallet genesis —
 * Solana RPC nodes only retain a rolling window of history unless queried against an archive node.
 */
export async function estimateEarliestActivity(
  address: string,
  maxPages = 5
): Promise<{ blockTime: number | null; signature: string | null }> {
  let before: string | undefined;
  let last: SignatureInfo | null = null;

  for (let page = 0; page < maxPages; page++) {
    const batch = await getSignaturesForAddress(address, { limit: 1000, before });
    if (batch.length === 0) break;
    last = batch[batch.length - 1];
    before = last.signature;
    if (batch.length < 1000) break; // reached the end of available history
  }

  return { blockTime: last?.blockTime ?? null, signature: last?.signature ?? null };
}

export interface HeliusEnhancedTransaction {
  signature: string;
  timestamp: number;
  type: string; // e.g. "SWAP", "TRANSFER"
  source: string;
  tokenTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    mint: string;
    tokenAmount: number;
  }>;
  nativeTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }>;
}

// Helius's REST (enhanced-transactions) API has its own rate limit, separate from the JSON-RPC
// endpoint — every call goes through this limiter (HELIUS_RATE_LIMIT_PER_SEC in .env) so a burst
// of per-wallet checks across a scan cycle queues up instead of 429ing.
const enhancedTxLimiter = new RateLimiter(env.HELIUS_RATE_LIMIT_PER_SEC);

// Short-lived cache of a wallet's recent transactions. hasRecentBuy() and hasRecentSell() both
// need the same underlying transaction list — without this cache they'd each fire a separate
// request for the same wallet, doubling call volume for no reason. Also means repeated scan
// cycles within the TTL window reuse the same fetch instead of re-hitting the API every ~30s.
const ENHANCED_TX_CACHE_TTL_MS = 3 * 60 * 1000;
const enhancedTxCache = new Map<string, { data: HeliusEnhancedTransaction[]; expiresAt: number }>();

/**
 * Fetches recent parsed/enhanced transactions for a wallet via Helius's REST API.
 * Requires HELIUS_API_KEY. Used to detect whether a wallet has recently bought a specific token
 * (a SWAP where the wallet is the recipient of the target mint).
 */
export async function getEnhancedTransactions(
  address: string,
  limit = 20
): Promise<HeliusEnhancedTransaction[]> {
  if (!env.HELIUS_API_KEY) {
    logger.warn("HELIUS_API_KEY not set — cannot fetch enhanced transactions");
    return [];
  }

  const cached = enhancedTxCache.get(address);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  try {
    const { data } = await enhancedTxLimiter.schedule(() =>
      withRateLimitRetry(
        () =>
          axios.get(`https://api.helius.xyz/v0/addresses/${address}/transactions`, {
            params: { "api-key": env.HELIUS_API_KEY, limit },
          }),
        { label: "helius.getEnhancedTransactions" }
      )
    );
    const result = Array.isArray(data) ? data : [];
    enhancedTxCache.set(address, { data: result, expiresAt: Date.now() + ENHANCED_TX_CACHE_TTL_MS });
    return result;
  } catch (err) {
    logger.error({ err, address }, "helius.getEnhancedTransactions failed");
    return [];
  }
}

/**
 * Checks whether `walletAddress` has bought `mintAddress` within `lookbackMinutes`.
 * "Bought" = a SWAP transaction where the wallet is the receiving side of the target mint.
 */
export async function hasRecentBuy(
  walletAddress: string,
  mintAddress: string,
  lookbackMinutes = 120
): Promise<boolean> {
  const txs = await getEnhancedTransactions(walletAddress, 20);
  const cutoff = Date.now() / 1000 - lookbackMinutes * 60;

  return txs.some((tx) => {
    if (tx.timestamp < cutoff) return false;
    if (tx.type !== "SWAP") return false;
    return (tx.tokenTransfers ?? []).some(
      (t) => t.mint === mintAddress && t.toUserAccount === walletAddress
    );
  });
}

/**
 * Checks whether `walletAddress` has sold `mintAddress` within `lookbackMinutes`.
 * "Sold" = a SWAP transaction where the wallet is the sending side of the target mint.
 */
export async function hasRecentSell(
  walletAddress: string,
  mintAddress: string,
  lookbackMinutes = 120
): Promise<boolean> {
  const txs = await getEnhancedTransactions(walletAddress, 20);
  const cutoff = Date.now() / 1000 - lookbackMinutes * 60;

  return txs.some((tx) => {
    if (tx.timestamp < cutoff) return false;
    if (tx.type !== "SWAP") return false;
    return (tx.tokenTransfers ?? []).some(
      (t) => t.mint === mintAddress && t.fromUserAccount === walletAddress
    );
  });
}

/**
 * Registers a Helius webhook that fires on new pool creation / token mint events.
 * Requires HELIUS_API_KEY. In production this should be run once during setup, not per-request.
 */
export async function registerNewTokenWebhook(webhookUrl: string, accountAddresses: string[]) {
  if (!env.HELIUS_API_KEY) {
    logger.warn("HELIUS_API_KEY not set — cannot register webhook");
    return null;
  }
  try {
    const { data } = await axios.post(
      `https://api.helius.xyz/v0/webhooks?api-key=${env.HELIUS_API_KEY}`,
      {
        webhookURL: webhookUrl,
        transactionTypes: ["TOKEN_MINT", "SWAP"],
        accountAddresses,
        webhookType: "enhanced",
      }
    );
    return data;
  } catch (err) {
    logger.error({ err }, "helius.registerNewTokenWebhook failed");
    return null;
  }
}
