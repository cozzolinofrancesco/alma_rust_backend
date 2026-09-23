/**
 * Run `fn` over `items` with bounded concurrency, preserving input order in the
 * returned results. Processes in fixed-size batches (Promise.all per batch).
 */
export async function runInBatches<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const size = Math.max(1, concurrency);
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const batchResults = await Promise.all(batch.map((item, j) => fn(item, i + j)));
    results.push(...batchResults);
  }
  return results;
}

export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly activeCount: number;
  readonly pendingCount: number;
}

/**
 * Rolling async concurrency limiter (pLimit-style). Unlike `runInBatches` there is no
 * batch barrier: a slot frees the instant a task settles and the next queued task starts
 * immediately. Use for a rolling budget across a stream of tasks.
 */
export function createLimiter(max: number): Limiter {
  const limit = Math.max(1, max);
  let active = 0;
  const queue: Array<() => void> = [];
  const pump = () => {
    while (queue.length > 0 && active < limit) {
      active += 1;
      const start = queue.shift()!;
      start();
    }
  };
  return {
    get activeCount() { return active; },
    get pendingCount() { return queue.length; },
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          fn().then(resolve, reject).finally(() => { active -= 1; pump(); });
        });
        pump();
      });
    },
  };
}

/**
 * Rolling RATE limiter: starts tasks no faster than `60000/perMinute` ms apart AND caps
 * simultaneous in-flight at `maxConcurrent`. The per-minute spacing is the primary control
 * (for APIs with a requests-per-minute quota); `maxConcurrent` just bounds open sockets.
 * Rolling, not batched — a freed slot pulls the next queued task subject to the spacing.
 */
export function createRateLimiter(opts: { perMinute: number; maxConcurrent?: number }): Limiter {
  const minSpacingMs = opts.perMinute > 0 ? 60_000 / opts.perMinute : 0;
  const maxConcurrent = Math.max(1, opts.maxConcurrent ?? Number.MAX_SAFE_INTEGER);
  let active = 0;
  let nextAllowedAt = 0;
  const queue: Array<() => void> = [];
  const pump = () => {
    while (queue.length > 0 && active < maxConcurrent) {
      const now = Date.now();
      if (now < nextAllowedAt) {
        setTimeout(pump, nextAllowedAt - now);
        return;
      }
      nextAllowedAt = now + minSpacingMs;
      active += 1;
      const start = queue.shift()!;
      start();
    }
  };
  return {
    get activeCount() { return active; },
    get pendingCount() { return queue.length; },
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          fn().then(resolve, reject).finally(() => { active -= 1; pump(); });
        });
        pump();
      });
    },
  };
}

/**
 * Retry an async operation with exponential backoff + jitter. Only retries when
 * `shouldRetry(err)` is true (default: always). Re-throws the last error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { retries?: number; baseDelayMs?: number; shouldRetry?: (err: unknown) => boolean },
): Promise<T> {
  const retries = opts?.retries ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;
  const shouldRetry = opts?.shouldRetry ?? (() => true);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !shouldRetry(err)) break;
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}
