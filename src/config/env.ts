/**
 * Environment configuration — loaded from `.env` (via dotenv) and validated
 * with zod. Secrets/credentials/runtime knobs only; screening *thresholds*
 * live in config.yaml (see ./rules.ts).
 *
 * Most fields are optional so that read-only test scripts (test:fetch /
 * test:enrich) can run without a fully-populated .env. Call
 * `assertRuntimeReady()` from the long-running scheduler to fail fast when the
 * pieces required for the full pipeline (Telegram + an LLM provider) are absent.
 */
import "dotenv/config";
import { z } from "zod";

/** Coerce common truthy/falsey strings to boolean. */
const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(v.trim())));

/** Optional trimmed string that treats empty/placeholder as undefined. */
const optionalStr = z
  .string()
  .optional()
  .transform((v) => {
    const t = v?.trim();
    return t ? t : undefined;
  });

const EnvSchema = z.object({
  POLL_INTERVAL_MINUTES: z.coerce.number().positive().default(7),
  RUN_ON_STARTUP: boolish(true),

  TELEGRAM_BOT_TOKEN: optionalStr,
  TELEGRAM_CHAT_ID: optionalStr,

  OPENROUTER_API_KEY: optionalStr,
  DEEPSEEK_API_KEY: optionalStr,
  LLM_MODEL: z.string().default("deepseek/deepseek-chat"),
  LLM_FALLBACK_MODEL: z.string().default("deepseek-chat"),
  OPENROUTER_HTTP_REFERER: optionalStr,
  OPENROUTER_APP_TITLE: optionalStr,

  JUPITER_API_KEY: optionalStr,

  GMGN_API_KEY: optionalStr,

  OKX_API_KEY: optionalStr,
  OKX_SECRET_KEY: optionalStr,
  OKX_PASSPHRASE: optionalStr,
  OKX_PROJECT_ID: optionalStr,

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOG_FILE: optionalStr,
});

function load() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  const e = parsed.data;

  // A placeholder passphrase (copied from .env.example guidance) counts as unset.
  const okxPassphrase =
    e.OKX_PASSPHRASE && /enter your passphrase/i.test(e.OKX_PASSPHRASE) ? undefined : e.OKX_PASSPHRASE;

  return {
    pollIntervalMinutes: e.POLL_INTERVAL_MINUTES,
    runOnStartup: e.RUN_ON_STARTUP,
    telegram: {
      botToken: e.TELEGRAM_BOT_TOKEN,
      chatId: e.TELEGRAM_CHAT_ID,
    },
    llm: {
      openrouterApiKey: e.OPENROUTER_API_KEY,
      deepseekApiKey: e.DEEPSEEK_API_KEY,
      model: e.LLM_MODEL,
      fallbackModel: e.LLM_FALLBACK_MODEL,
      httpReferer: e.OPENROUTER_HTTP_REFERER,
      appTitle: e.OPENROUTER_APP_TITLE,
    },
    jupiter: {
      apiKey: e.JUPITER_API_KEY,
    },
    gmgn: {
      apiKey: e.GMGN_API_KEY,
      get enabled() {
        return Boolean(e.GMGN_API_KEY);
      },
    },
    okx: {
      apiKey: e.OKX_API_KEY,
      secretKey: e.OKX_SECRET_KEY,
      passphrase: okxPassphrase,
      projectId: e.OKX_PROJECT_ID,
      get enabled() {
        return Boolean(e.OKX_API_KEY && e.OKX_SECRET_KEY && okxPassphrase);
      },
    },
    logLevel: e.LOG_LEVEL,
    logFile: e.LOG_FILE,
  };
}

export const env = load();
export type AppEnv = typeof env;

/**
 * Ensure the config required for a full live run is present. Throws with a
 * clear, actionable message listing everything missing.
 */
export function assertRuntimeReady(): void {
  const missing: string[] = [];
  if (!env.telegram.botToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!env.telegram.chatId) missing.push("TELEGRAM_CHAT_ID");
  if (!env.llm.openrouterApiKey && !env.llm.deepseekApiKey)
    missing.push("OPENROUTER_API_KEY (or DEEPSEEK_API_KEY)");
  if (missing.length) {
    throw new Error(
      `Missing required configuration: ${missing.join(", ")}.\n` +
        `Copy .env.example to .env and fill these in before running the scheduler.`,
    );
  }
}
