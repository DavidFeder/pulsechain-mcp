import type { PiteasQuoteResult } from "../../../data/piteas.js";
import type { AppConfig } from "../../../types.js";
import { DEFAULT_DISCOVERY_RETRY_COUNT } from "./constants.js";
import { currentMs, nowIso, timestampMs } from "./decimalMath.js";
import type {
  PiteasAccumulationPlanDeps,
  PiteasReliability,
  QuoteAttemptMetadata,
  QuotePoint,
  QuoteScheduler,
  ScheduledQuoteResult,
} from "./types.js";

export function createQuoteScheduler(input: {
  config: AppConfig;
  deps: PiteasAccumulationPlanDeps;
  selectedConcurrency: number;
}): QuoteScheduler {
  const attempts: QuoteAttemptMetadata[] = [];

  async function quote(
    req: {
      tokenIn: string;
      tokenOut: string;
      amount: string;
      allowedSlippage: number;
      account?: string;
    },
    options: {
      allowRetries: boolean;
      maxRetries?: number;
    },
  ): Promise<ScheduledQuoteResult> {
    const requestAttempts: QuoteAttemptMetadata[] = [];
    const maxRetries = options.allowRetries
      ? options.maxRetries ?? DEFAULT_DISCOVERY_RETRY_COUNT
      : 0;
    let attempt = 0;
    let lastResult: PiteasQuoteResult | null = null;

    while (attempt <= maxRetries) {
      const requestStartedAt = nowIso(input.deps);
      const startedMs = timestampMs(requestStartedAt) ?? currentMs(input.deps);
      const result = await getPiteasQuoteWithTimeout(input.config, input.deps, req);
      const responseReceivedAt = nowIso(input.deps);
      const latencyMs = Math.max(
        0,
        (timestampMs(responseReceivedAt) ?? currentMs(input.deps)) - startedMs,
      );
      const metadata: QuoteAttemptMetadata = {
        attempt,
        requestStartedAt,
        responseReceivedAt,
        latencyMs,
        ok: result.ok,
        status: result.ok ? null : result.status ?? null,
        reason: result.ok ? null : result.reason,
      };
      attempts.push(metadata);
      requestAttempts.push(metadata);
      lastResult = result;
      if (result.ok || !isRetryablePiteasFailure(result) || attempt >= maxRetries) {
        break;
      }
      await sleepMs(input.deps, retryBackoffMs(attempt));
      attempt += 1;
    }

    return {
      result: lastResult!,
      requestStartedAt: requestAttempts[0]!.requestStartedAt,
      responseReceivedAt: requestAttempts.at(-1)!.responseReceivedAt,
      attempts: requestAttempts,
      schedulerRetryCount: Math.max(0, requestAttempts.length - 1),
    };
  }

  async function quoteMany<T>(
    items: T[],
    concurrency: number,
    task: (item: T, index: number) => Promise<QuotePoint>,
  ): Promise<QuotePoint[]> {
    const results: QuotePoint[] = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < items.length) {
          const index = nextIndex;
          nextIndex += 1;
          results[index] = await task(items[index]!, index);
        }
      }),
    );
    return results;
  }

  return {
    quote,
    quoteMany,
    metrics: () => buildReliabilityMetrics(attempts, input.selectedConcurrency),
  };
}

async function getPiteasQuoteWithTimeout(
  config: AppConfig,
  deps: PiteasAccumulationPlanDeps,
  req: {
    tokenIn: string;
    tokenOut: string;
    amount: string;
    allowedSlippage: number;
    account?: string;
  },
): Promise<PiteasQuoteResult> {
  const timeoutMs = Math.max(1, config.httpTimeoutMs ?? 10_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PiteasQuoteResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        source: "piteas",
        reason: `Piteas request timed out after ${timeoutMs}ms`,
        advisory: true,
      });
    }, timeoutMs);
  });
  try {
    return await Promise.race([deps.getPiteasQuote(config, req), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRetryablePiteasFailure(result: PiteasQuoteResult): boolean {
  if (result.ok) return false;
  if (result.status === 429) return false;
  if (result.status !== undefined && result.status >= 500 && result.status < 600) {
    return true;
  }
  return /timed out|timeout|HTTP 5\d\d/i.test(result.reason);
}

function retryBackoffMs(attempt: number): number {
  const base = 250 * 2 ** attempt;
  const jitter = ((attempt + 1) * 37) % 120;
  return Math.min(5_000, base + jitter);
}

async function sleepMs(deps: PiteasAccumulationPlanDeps, ms: number): Promise<void> {
  if (ms <= 0) return;
  if (deps.sleep) {
    await deps.sleep(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function buildReliabilityMetrics(
  attempts: QuoteAttemptMetadata[],
  selectedConcurrency: number,
): PiteasReliability {
  const latencies = attempts.map((attempt) => attempt.latencyMs).sort((a, b) => a - b);
  return {
    requestsAttempted: attempts.length,
    requestsSucceeded: attempts.filter((attempt) => attempt.ok).length,
    requestsFailed: attempts.filter((attempt) => !attempt.ok).length,
    timeoutCount: attempts.filter((attempt) =>
      /timed out|timeout/i.test(attempt.reason ?? ""),
    ).length,
    http500Count: attempts.filter(
      (attempt) =>
        (attempt.status !== null && attempt.status >= 500 && attempt.status < 600) ||
        /HTTP 5\d\d/i.test(attempt.reason ?? ""),
    ).length,
    retryCount: attempts.filter((attempt) => attempt.attempt > 0).length,
    medianLatencyMs: percentile(latencies, 0.5),
    p90LatencyMs: percentile(latencies, 0.9),
    selectedConcurrency,
  };
}

function percentile(values: number[], pct: number): number | null {
  if (values.length === 0) return null;
  const index = Math.min(values.length - 1, Math.ceil(values.length * pct) - 1);
  return values[index] ?? null;
}
