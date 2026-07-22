import axios from "axios";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";

export interface LLMJsonRequest {
  system: string;
  user: string;
  /** Hint the model to keep responses cheap/fast — narrative tagging doesn't need long output. */
  maxTokens?: number;
}

export function isLLMConfigured(): boolean {
  if (env.LLM_PROVIDER === "openai" && !env.OPENAI_API_KEY) return false;
  return true;
}

/**
 * Calls the configured LLM provider and returns raw text output.
 * Currently supports OpenAI's chat completions endpoint. Swap the body of this function
 * (or branch on env.LLM_PROVIDER) to point at Anthropic, a self-hosted gateway, etc.
 */
export async function completeJson(req: LLMJsonRequest): Promise<string | null> {
  if (!isLLMConfigured()) {
    logger.warn("LLM not configured (OPENAI_API_KEY missing) — skipping LLM call");
    return null;
  }

  if (env.LLM_PROVIDER !== "openai") {
    logger.warn({ provider: env.LLM_PROVIDER }, "unsupported LLM_PROVIDER, only 'openai' is implemented");
    return null;
  }

  try {
    const { data } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: env.OPENAI_MODEL,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        max_tokens: req.maxTokens ?? 300,
        temperature: 0.2,
        response_format: { type: "json_object" },
      },
      {
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 15_000,
      }
    );

    return data?.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    logger.error({ err }, "llmClient.completeJson failed");
    return null;
  }
}

/** OpenAI-style chat message, including the tool-call/tool-result shapes needed for agent loops. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ChatCompletionResult {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}

/**
 * One turn of an OpenAI chat completion with optional tool/function definitions.
 * Returns either final text content, or a list of tool calls the model wants executed —
 * the caller (aiAssistant.ts) is responsible for running the agent loop.
 */
export async function chatWithTools(
  messages: ChatMessage[],
  tools?: ToolDefinition[]
): Promise<ChatCompletionResult | null> {
  if (!isLLMConfigured()) {
    logger.warn("LLM not configured (OPENAI_API_KEY missing) — skipping chat call");
    return null;
  }
  if (env.LLM_PROVIDER !== "openai") {
    logger.warn({ provider: env.LLM_PROVIDER }, "unsupported LLM_PROVIDER, only 'openai' is implemented");
    return null;
  }

  try {
    const { data } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: env.OPENAI_MODEL,
        messages,
        ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
        max_tokens: 500,
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 20_000,
      }
    );

    const message = data?.choices?.[0]?.message;
    if (!message) return null;

    const toolCalls = (message.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    return { content: message.content ?? null, toolCalls };
  } catch (err) {
    logger.error({ err }, "llmClient.chatWithTools failed");
    return null;
  }
}
