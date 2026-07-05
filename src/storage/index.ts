/**
 * State tracking — remembers which pools have already been sent to Telegram so
 * we don't re-notify on every cycle. Backed by a single JSON file (no DB), with
 * atomic writes (temp file + rename) and automatic pruning of old entries.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createLogger } from "../util/logger.js";

const log = createLogger("storage");

const EntrySchema = z.object({
  symbol: z.string(),
  /** When the pool was first fully processed (reached the LLM stage). */
  at: z.number(),
  score: z.number().optional(),
  /** Whether an alert was actually sent to Telegram. */
  notified: z.boolean().default(false),
});
const StoreSchema = z.record(z.string(), EntrySchema);
type Entry = z.infer<typeof EntrySchema>;

function defaultStorePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../data/sent.json");
}

const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // forget pools after 7 days

export class SentStore {
  private data: Record<string, Entry> = {};

  constructor(private readonly path: string = process.env.STATE_PATH || defaultStorePath()) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = StoreSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      if (parsed.success) {
        this.data = parsed.data;
      } else {
        log.warn(`state file at ${this.path} is malformed — starting fresh`);
      }
    } catch (err) {
      log.warn(`could not read state file ${this.path} — starting fresh`, err);
    }
    this.prune();
  }

  private prune(): void {
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    let removed = 0;
    for (const [addr, entry] of Object.entries(this.data)) {
      if (entry.at < cutoff) {
        delete this.data[addr];
        removed++;
      }
    }
    if (removed > 0) log.debug(`pruned ${removed} stale state entries`);
  }

  /** True once a pool has been fully processed (reached the LLM), notified or not. */
  has(poolAddress: string): boolean {
    return poolAddress in this.data;
  }

  /** Record that a pool was processed this cycle (dedupes future cycles). */
  markProcessed(poolAddress: string, meta: { symbol: string; score?: number; notified: boolean }): void {
    this.data[poolAddress] = { symbol: meta.symbol, at: Date.now(), score: meta.score, notified: meta.notified };
  }

  /** Persist to disk atomically (write temp, then rename). */
  save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.path);
    } catch (err) {
      log.error(`failed to persist state to ${this.path}`, err);
    }
  }

  get size(): number {
    return Object.keys(this.data).length;
  }
}
