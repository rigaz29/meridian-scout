/**
 * LLM deep-dive analyzer.
 *
 * Uses the OpenAI SDK against OpenAI-compatible endpoints. OpenRouter is the
 * primary provider; DeepSeek-direct is an automatic fallback used when
 * OpenRouter errors/rate-limits. Output is forced to JSON and validated with
 * zod; on a validation miss we retry once with a stricter instruction, then
 * move to the next provider, then give up (the caller skips the token — the
 * screening cycle never crashes on a bad LLM response).
 *
 * The LLM only scores/assesses. It makes no execution or trading decision.
 */
import OpenAI from "openai";
import { z } from "zod";
import { createLogger } from "../util/logger.js";
import { env } from "../config/env.js";
import type { EnrichedToken, LlmVerdict } from "../types.js";
import { buildMessages } from "./prompt.js";

const log = createLogger("llm");

const VerdictSchema = z.object({
  score: z.coerce.number().transform((n) => Math.max(0, Math.min(100, Math.round(n)))),
  verdict: z
    .string()
    .transform((v) => v.trim().toLowerCase())
    .pipe(z.enum(["promising", "risky", "avoid"])),
  reasoning: z.string().default(""),
  red_flags: z.array(z.string()).default([]),
  green_flags: z.array(z.string()).default([]),
});

interface Provider {
  name: string;
  client: OpenAI;
  model: string;
}

let providersCache: Provider[] | null = null;

function providers(): Provider[] {
  if (providersCache) return providersCache;
  const list: Provider[] = [];

  if (env.llm.openrouterApiKey) {
    list.push({
      name: "openrouter",
      model: env.llm.model,
      client: new OpenAI({
        apiKey: env.llm.openrouterApiKey,
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: {
          ...(env.llm.httpReferer ? { "HTTP-Referer": env.llm.httpReferer } : {}),
          ...(env.llm.appTitle ? { "X-Title": env.llm.appTitle } : {}),
        },
      }),
    });
  }
  if (env.llm.deepseekApiKey) {
    list.push({
      name: "deepseek",
      model: env.llm.fallbackModel,
      client: new OpenAI({ apiKey: env.llm.deepseekApiKey, baseURL: "https://api.deepseek.com" }),
    });
  }

  providersCache = list;
  return list;
}

export function llmConfigured(): boolean {
  return providers().length > 0;
}

function extractJson(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Tolerate stray prose/code fences by grabbing the outermost JSON object.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

async function callOnce(
  provider: Provider,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
): Promise<string | null> {
  const resp = await provider.client.chat.completions.create({
    model: provider.model,
    messages,
    temperature: 0.3,
    max_tokens: 800,
    response_format: { type: "json_object" },
  });
  return resp.choices[0]?.message?.content ?? null;
}

/**
 * Analyze a candidate. Returns the validated verdict and the provider that
 * produced it, or null if every provider/attempt failed.
 */
export async function analyzeToken(
  token: EnrichedToken,
): Promise<{ verdict: LlmVerdict; provider: string } | null> {
  const provs = providers();
  if (provs.length === 0) {
    log.warn("no LLM provider configured (set OPENROUTER_API_KEY or DEEPSEEK_API_KEY)");
    return null;
  }

  const { system, user } = buildMessages(token);
  const baseMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  for (const provider of provs) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const messages =
        attempt === 1
          ? baseMessages
          : [
              ...baseMessages,
              {
                role: "user" as const,
                content:
                  "Your previous reply was not valid JSON matching the schema. Reply again with ONLY the JSON object (keys: score, verdict, reasoning, red_flags, green_flags). No markdown, no code fences, no extra text.",
              },
            ];
      try {
        const content = await callOnce(provider, messages);
        if (!content) {
          log.warn(`${provider.name}: empty response (attempt ${attempt})`);
          continue;
        }
        const parsed = VerdictSchema.safeParse(extractJson(content));
        if (parsed.success) {
          return { verdict: parsed.data, provider: provider.name };
        }
        log.warn(`${provider.name}: invalid verdict JSON (attempt ${attempt}): ${parsed.error.issues[0]?.message}`);
      } catch (err) {
        log.warn(`${provider.name}: request failed (attempt ${attempt}) — trying fallback`, err);
        break; // request-level failure: skip remaining attempts, go to next provider
      }
    }
  }

  log.error(`all LLM providers/attempts failed for ${token.pool.target.symbol}`);
  return null;
}
