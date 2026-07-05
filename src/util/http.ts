/**
 * Small HTTP/JSON helper built on the global `fetch` (Node's built-in undici).
 *
 * Features: per-request timeout (AbortController), retry with exponential
 * backoff on transient failures (network errors, HTTP 429, HTTP 5xx), and
 * immediate failure on permanent client errors (4xx except 429). Every 3rd-party
 * response is returned as `unknown` — callers are expected to validate the
 * shape with zod.
 */
import { createLogger } from "./logger.js";

const log = createLogger("http");

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly bodySnippet?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface HttpOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Serialized JSON string or object (object is JSON.stringify'd). */
  body?: string | Record<string, unknown> | unknown[];
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /** Label used in log lines for context. */
  label?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_UA =
  "Mozilla/5.0 (compatible; MeteoraTokenScreener/1.0; +https://github.com/meteora-token-screener)";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Fetch a URL and parse the JSON body. Throws HttpError on permanent/final failure. */
export async function fetchJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    label = url,
  } = opts;

  const bodyText =
    body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);

  const finalHeaders: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": DEFAULT_UA,
    ...(bodyText !== undefined ? { "Content-Type": "application/json" } : {}),
    ...headers,
  };

  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const isLast = attempt === retries;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: bodyText,
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Transient server-side conditions → back off and retry.
      if ((res.status === 429 || res.status >= 500) && !isLast) {
        const retryAfter = Number.parseInt(res.headers.get("retry-after") || "", 10);
        const delay = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : retryDelayMs * 2 ** (attempt - 1);
        log.warn(`${label}: HTTP ${res.status}, retry ${attempt}/${retries - 1} in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        const snippet = (await res.text().catch(() => "")).slice(0, 300);
        throw new HttpError(`HTTP ${res.status} for ${label}`, res.status, url, snippet);
      }

      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      // HttpError from a non-ok, non-retryable response — do not retry.
      if (err instanceof HttpError) throw err;
      // Network error / timeout / abort — retry unless we're out of attempts.
      if (isLast) break;
      const delay = retryDelayMs * 2 ** (attempt - 1);
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`${label}: ${reason}, retry ${attempt}/${retries - 1} in ${delay}ms`);
      await sleep(delay);
    }
  }

  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new HttpError(`Request failed after ${retries} attempts: ${reason}`, 0, url);
}
