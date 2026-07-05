/**
 * Tiny leveled logger — console always, optional append to a file.
 *
 * Reads LOG_LEVEL / LOG_FILE from the environment lazily (at call time) so it
 * has no import-time dependency on the config module and works regardless of
 * when dotenv is loaded, as long as entrypoints `import "dotenv/config"` first.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

function activeLevel(): number {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}

let fileReady = false;
function logFile(): string | null {
  const f = process.env.LOG_FILE?.trim();
  if (!f) return null;
  if (!fileReady) {
    try {
      mkdirSync(dirname(f), { recursive: true });
      fileReady = true;
    } catch {
      /* fall back to console-only */
    }
  }
  return f;
}

function emit(level: LogLevel, scope: string, msg: string, extra?: unknown) {
  if (LEVELS[level] < activeLevel()) return;
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  let line = `${ts} ${tag} [${scope}] ${msg}`;
  if (extra !== undefined) {
    const detail = extra instanceof Error ? extra.stack || extra.message : safeStringify(extra);
    line += ` ${detail}`;
  }
  const sink = level === "error" || level === "warn" ? console.error : console.log;
  sink(line);

  const file = logFile();
  if (file) {
    try {
      appendFileSync(file, line + "\n");
    } catch {
      /* ignore file write failures */
    }
  }
}

function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Create a scoped logger, e.g. `const log = createLogger("meteora")`. */
export function createLogger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit("debug", scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit("info", scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit("warn", scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit("error", scope, msg, extra),
  };
}

export type Logger = ReturnType<typeof createLogger>;
