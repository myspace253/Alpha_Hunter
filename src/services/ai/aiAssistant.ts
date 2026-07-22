import { chatWithTools, isLLMConfigured, type ChatMessage } from "./llmClient";
import { AGENT_TOOLS, executeTool } from "./tools";
import { logger } from "../../utils/logger";

const MAX_TOOL_ITERATIONS = 4; // hard cap so a confused model can't loop forever / rack up cost

const SYSTEM_PROMPT = `You are the AI Assistant inside "Solana AI Alpha Hunter", a Telegram trading-signal bot.
You help users understand token scores, risk assessments, and wallet track records using the tools available to you.

Rules:
- Always call a tool to get real data before answering questions about a specific token, wallet, or current rankings — never guess numbers from memory.
- Keep answers concise and Telegram-friendly: short paragraphs, occasional bullet points, no long essays.
- You are not a financial advisor. If asked for direct trading instructions ("should I buy this"), explain the data you found and let the user decide — don't tell them what to do with their money.
- Be honest about uncertainty. If a tool returns no data, say so plainly instead of speculating.
- Numbers should be attributed to what they measure (e.g. "AI Score of 82/100", not just "82").`;

export interface AssistantResult {
  answer: string;
  toolsUsed: string[];
}

/**
 * Runs a bounded tool-calling agent loop: ask the model, execute any tools it requests,
 * feed results back, repeat until it produces a final text answer or the iteration cap hits.
 */
export async function askAssistant(
  question: string,
  ctx: { chatId: string; tokenAddressHint?: string }
): Promise<AssistantResult> {
  if (!isLLMConfigured()) {
    return {
      answer:
        "The AI Assistant isn't configured yet — an OPENAI_API_KEY needs to be set in .env for free-form Q&A. In the meantime, try /analysis <token_address> or /wallet <address>.",
      toolsUsed: [],
    };
  }

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(ctx.tokenAddressHint
      ? ([
          {
            role: "user",
            content: `(Context: the user's message referenced this token address: ${ctx.tokenAddressHint})`,
          },
        ] as ChatMessage[])
      : []),
    { role: "user", content: question },
  ];

  const toolsUsed: string[] = [];

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const result = await chatWithTools(messages, AGENT_TOOLS);

    if (!result) {
      return { answer: "Sorry, I couldn't reach the AI assistant right now — please try again shortly.", toolsUsed };
    }

    if (result.toolCalls.length === 0) {
      return { answer: result.content ?? "I don't have a good answer for that.", toolsUsed };
    }

    // Model wants to call tools — append its request, execute each, append results, loop.
    messages.push({
      role: "assistant",
      content: result.content,
      tool_calls: result.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    for (const call of result.toolCalls) {
      toolsUsed.push(call.name);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch (err) {
        logger.warn({ err, call }, "askAssistant: failed to parse tool arguments");
      }

      let toolResult: unknown;
      try {
        toolResult = await executeTool(call.name, args, { chatId: ctx.chatId });
      } catch (err) {
        logger.error({ err, call }, "askAssistant: tool execution failed");
        toolResult = { error: "Tool execution failed." };
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.name,
        content: JSON.stringify(toolResult),
      });
    }
  }

  logger.warn({ question }, "askAssistant hit max tool iterations without a final answer");
  return {
    answer:
      "I gathered some data but couldn't finish reasoning about it in time — try asking a more specific question.",
    toolsUsed,
  };
}
