/**
 * Interactive setup wizard. Run: `npm run setup`
 *
 * Walks the user through every credential/knob, paste-by-paste, then writes a
 * `.env` file. It edits a copy of `.env.example` in place — replacing only the
 * values the user actually provides — so all the explanatory comments and
 * sensible defaults are preserved. Optionally sends a Telegram test message to
 * confirm the bot token + chat id are correct.
 */
import { createInterface, type Interface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Line reader that buffers every incoming line into a queue, so it works
 * whether input is typed interactively or piped in all at once (the readline
 * "promises" API loses lines emitted before the next question() attaches).
 */
class LineReader {
  private rl: Interface;
  private queue: string[] = [];
  private waiting: ((line: string) => void) | null = null;
  private closed = false;

  constructor() {
    this.rl = createInterface({ input, output, terminal: false });
    this.rl.on("line", (line) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(line);
      } else {
        this.queue.push(line);
      }
    });
    this.rl.on("close", () => {
      this.closed = true;
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve("");
      }
    });
  }

  question(prompt: string): Promise<string> {
    output.write(prompt);
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve("");
    return new Promise<string>((resolve) => {
      this.waiting = resolve;
    });
  }

  close(): void {
    this.rl.close();
  }
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const envExamplePath = join(projectRoot, ".env.example");
const envPath = join(projectRoot, ".env");

// ── little ANSI helpers (no dependency) ──────────────────────────
const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

async function main() {
  const rl = new LineReader();
  const answers = new Map<string, string>();

  const ask = async (opts: {
    key: string;
    label: string;
    hint?: string;
    required?: boolean;
    def?: string;
  }): Promise<void> => {
    const { key, label, hint, required, def } = opts;
    if (hint) console.log(c.dim("   " + hint));
    const suffix = def ? c.dim(` [${def}]`) : required ? c.red(" (required)") : c.dim(" (optional, Enter to skip)");
    for (;;) {
      const raw = (await rl.question(`${c.cyan("›")} ${c.bold(label)}${suffix}: `)).trim();
      if (raw) {
        answers.set(key, raw);
        return;
      }
      if (!required) return; // skip → keep the .env.example default
      console.log(c.red("   This value is required. Please paste it."));
    }
  };

  const section = (title: string) => console.log("\n" + c.bold(c.yellow("▸ " + title)));

  try {
    console.log(c.bold("\n🛠  meridian-scout — setup\n"));
    console.log("Paste each value when prompted. Press Enter to skip an optional field or accept a default.\n");

    if (!existsSync(envExamplePath)) {
      console.log(c.red(`Cannot find .env.example at ${envExamplePath} — run this from the project root.`));
      process.exit(1);
    }

    if (existsSync(envPath)) {
      const overwrite = (await rl.question(c.yellow("A .env already exists. Overwrite it? (y/N): "))).trim().toLowerCase();
      if (overwrite !== "y" && overwrite !== "yes") {
        console.log("Aborted — your existing .env was left untouched.");
        rl.close();
        return;
      }
      copyFileSync(envPath, envPath + ".bak");
      console.log(c.dim(`   Backed up existing .env → .env.bak`));
    }

    section("Telegram (required)");
    await ask({
      key: "TELEGRAM_BOT_TOKEN",
      label: "Telegram bot token",
      hint: "Create a bot with @BotFather → /newbot, then paste the token it gives you.",
      required: true,
    });
    await ask({
      key: "TELEGRAM_CHAT_ID",
      label: "Telegram chat / channel id",
      hint: "DM @userinfobot for your personal id, or use a channel id like -100xxxxxxxxxx (bot must be admin).",
      required: true,
    });

    section("LLM analyzer (required)");
    await ask({
      key: "OPENROUTER_API_KEY",
      label: "OpenRouter API key",
      hint: "Get one at https://openrouter.ai/keys",
      required: true,
    });
    await ask({
      key: "DEEPSEEK_API_KEY",
      label: "DeepSeek API key (fallback)",
      hint: "Optional — used only if OpenRouter fails. https://platform.deepseek.com",
    });
    await ask({
      key: "LLM_MODEL",
      label: "LLM model",
      hint: "Enter to keep the default. Use deepseek/deepseek-r1 for deeper (pricier) reasoning.",
      def: "deepseek/deepseek-chat",
    });

    section("Jupiter enrichment (optional)");
    await ask({
      key: "JUPITER_API_KEY",
      label: "Jupiter API key",
      hint: "Optional — keyless works on a free tier. A key (https://portal.jup.ag) raises rate limits.",
    });

    section("OKX DEX enrichment (optional)");
    console.log(c.dim("   Enables the cross-DEX price/security check. Skip all four to disable OKX. https://web3.okx.com"));
    await ask({ key: "OKX_API_KEY", label: "OKX API key" });
    await ask({ key: "OKX_SECRET_KEY", label: "OKX secret key" });
    await ask({ key: "OKX_PASSPHRASE", label: "OKX passphrase" });
    await ask({ key: "OKX_PROJECT_ID", label: "OKX project id" });

    section("Runtime (optional)");
    await ask({
      key: "POLL_INTERVAL_MINUTES",
      label: "Poll interval (minutes)",
      hint: "How often to run a screening cycle.",
      def: "7",
    });
    await ask({
      key: "LOG_LEVEL",
      label: "Log level (debug|info|warn|error)",
      def: "info",
    });

    // ── Write .env by substituting values into .env.example ──────
    const lines = readFileSync(envExamplePath, "utf8").split("\n");
    const out = lines.map((line) => {
      const m = line.match(/^([A-Z0-9_]+)=/);
      if (m && answers.has(m[1]!)) return `${m[1]}=${answers.get(m[1]!)}`;
      return line;
    });
    writeFileSync(envPath, out.join("\n"));
    console.log(c.green(`\n✔ Wrote ${envPath}`));

    // ── Optional Telegram test ──────────────────────────────────
    const test = (await rl.question("\nSend a test message to Telegram now to verify? (Y/n): ")).trim().toLowerCase();
    if (test !== "n" && test !== "no") {
      await sendTelegramTest(answers.get("TELEGRAM_BOT_TOKEN")!, answers.get("TELEGRAM_CHAT_ID")!);
    }

    console.log(c.bold(c.green("\n🎉 Setup complete!")) + "\n");
    console.log("Next steps:");
    console.log(`  ${c.cyan("npm run once")}     ${c.dim("# run one full screening cycle now")}`);
    console.log(`  ${c.cyan("npm start")}        ${c.dim("# run continuously on the schedule (after npm run build)")}`);
    console.log(c.dim("\nTune thresholds anytime in config.yaml — no code changes needed.\n"));
  } finally {
    rl.close();
  }
}

async function sendTelegramTest(token: string, chatId: string): Promise<void> {
  try {
    const { Bot } = await import("grammy");
    const bot = new Bot(token);
    await bot.api.sendMessage(
      chatId,
      "✅ <b>meridian-scout</b>\nSetup berhasil — bot terhubung ke chat ini.",
      { parse_mode: "HTML" },
    );
    console.log(c.green("✔ Test message sent — check your Telegram."));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(c.red(`✗ Could not send test message: ${msg}`));
    console.log(c.dim("   Double-check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID. You can re-run `npm run setup` anytime."));
  }
}

main().catch((err) => {
  console.error("setup failed:", err);
  process.exit(1);
});
