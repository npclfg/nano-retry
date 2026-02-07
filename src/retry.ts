/**
 * Options for configuring retry behavior.
 */
export interface RetryOptions<T> {
  /**
   * Maximum number of retry attempts (not counting the initial attempt).
   * @default 3
   */
  retries?: number;

  /**
   * Initial delay in milliseconds before the first retry.
   * @default 1000
   */
  minTimeout?: number;

  /**
   * Maximum delay in milliseconds between retries.
   * @default 30000
   */
  maxTimeout?: number;

  /**
   * Exponential backoff factor.
   * @default 2
   */
  factor?: number;

  /**
   * Whether to add random jitter to delays (±25%). Helps prevent thundering herd.
   * @default true
   */
  jitter?: boolean;

  /**
   * Timeout in milliseconds for each individual attempt.
   * If an attempt exceeds this, it's aborted and counts as a failed attempt.
   */
  attemptTimeout?: number;

  /**
   * Maximum total time in milliseconds for all attempts combined.
   * If exceeded, the operation fails immediately.
   */
  totalTimeout?: number;

  /**
   * AbortSignal to cancel the retry operation.
   */
  signal?: AbortSignal;

  /**
   * Predicate to determine if an error should trigger a retry.
   * Return `true` to retry, `false` to fail immediately.
   * If not provided, all errors trigger retries.
   */
  retryIf?: (error: unknown, context: RetryContext) => boolean | Promise<boolean>;

  /**
   * Callback invoked after each failed attempt, before the delay.
   * Useful for logging or metrics. Can be async.
   */
  onRetry?: (error: unknown, context: RetryContext) => void | Promise<void>;
}

/**
 * Context passed to callbacks with information about the current retry state.
 */
export interface RetryContext {
  /** Current attempt number (1-based, includes initial attempt) */
  attempt: number;
  /** Number of retries remaining */
  retriesLeft: number;
  /** Total elapsed time in milliseconds since the operation started */
  elapsed: number;
  /** Delay before the next retry (0 if no more retries) */
  nextDelay: number;
}

/**
 * Error thrown when a retry operation is aborted.
 */
export class AbortError extends Error {
  readonly name = "AbortError";
  readonly isRetryAbort = true;

  constructor(message = "Retry operation was aborted") {
    super(message);
  }
}

/**
 * Error thrown when a retry operation times out.
 */
export class TimeoutError extends Error {
  readonly name = "TimeoutError";
  readonly isRetryTimeout = true;

  constructor(message = "Retry operation timed out") {
    super(message);
  }
}

// Default options
const DEFAULTS = {
  retries: 3,
  minTimeout: 1000,
  maxTimeout: 30000,
  factor: 2,
  jitter: true,
} as const;

/**
 * Calculate delay for a given attempt with exponential backoff.
 */
function calculateDelay(
  attempt: number,
  minTimeout: number,
  maxTimeout: number,
  factor: number,
  jitter: boolean
): number {
  // Exponential backoff: minTimeout * factor^(attempt-1)
  let delay = minTimeout * Math.pow(factor, attempt - 1);

  // Cap at maxTimeout
  delay = Math.min(delay, maxTimeout);

  // Add jitter (±25%)
  if (jitter) {
    const jitterRange = delay * 0.25;
    delay = delay - jitterRange + Math.random() * jitterRange * 2;
  }

  return Math.round(delay);
}

/**
 * Sleep for a specified duration, respecting abort signal.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }

    let onAbort: (() => void) | undefined;

    const timeoutId = setTimeout(() => {
      if (onAbort && signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);

    if (signal) {
      onAbort = () => {
        clearTimeout(timeoutId);
        reject(new AbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Execute a function with a timeout.
 */
async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }

    let settled = false;

    const cleanup = () => {
      if (onAbort && signal) {
        signal.removeEventListener("abort", onAbort);
      }
      clearTimeout(timeoutId);
    };

    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new TimeoutError(`Attempt timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    let onAbort: (() => void) | undefined;

    if (signal) {
      onAbort = () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new AbortError());
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    fn()
      .then((result) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(result);
        }
      })
      .catch((error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      });
  });
}

/**
 * Retry an async function with exponential backoff.
 *
 * @param fn - The async function to retry. Receives the current attempt number (1-based).
 * @param options - Configuration options for retry behavior.
 * @returns The result of the function if it succeeds.
 * @throws The last error if all retries are exhausted, or AbortError/TimeoutError if cancelled.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const result = await retry(() => fetchData());
 *
 * // With options
 * const result = await retry(
 *   async (attempt) => {
 *     console.log(`Attempt ${attempt}`);
 *     return await fetchData();
 *   },
 *   {
 *     retries: 5,
 *     minTimeout: 500,
 *     retryIf: (error) => error.status === 429,
 *     onRetry: (error, ctx) => console.log(`Retry ${ctx.attempt}, waiting ${ctx.nextDelay}ms`),
 *   }
 * );
 * ```
 */
export async function retry<T>(
  fn: (attempt: number) => T | Promise<T>,
  options: RetryOptions<T> = {}
): Promise<T> {
  const {
    retries = DEFAULTS.retries,
    minTimeout = DEFAULTS.minTimeout,
    maxTimeout = DEFAULTS.maxTimeout,
    factor = DEFAULTS.factor,
    jitter = DEFAULTS.jitter,
    attemptTimeout,
    totalTimeout,
    signal,
    retryIf,
    onRetry,
  } = options;

  // Validate options
  if (retries < 0 || !Number.isInteger(retries)) {
    throw new TypeError("retries must be a non-negative integer");
  }
  if (minTimeout <= 0) {
    throw new TypeError("minTimeout must be positive");
  }
  if (maxTimeout <= 0) {
    throw new TypeError("maxTimeout must be positive");
  }
  if (factor <= 0) {
    throw new TypeError("factor must be positive");
  }
  if (attemptTimeout !== undefined && attemptTimeout <= 0) {
    throw new TypeError("attemptTimeout must be positive");
  }
  if (totalTimeout !== undefined && totalTimeout <= 0) {
    throw new TypeError("totalTimeout must be positive");
  }

  // Check if already aborted
  if (signal?.aborted) {
    throw new AbortError();
  }

  const startTime = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const elapsed = Date.now() - startTime;

    // Check total timeout
    if (totalTimeout !== undefined && elapsed >= totalTimeout) {
      throw new TimeoutError(`Total timeout of ${totalTimeout}ms exceeded`);
    }

    // Check abort signal
    if (signal?.aborted) {
      throw new AbortError();
    }

    try {
      // Execute the function, with optional per-attempt timeout
      if (attemptTimeout !== undefined) {
        return await withTimeout(() => Promise.resolve(fn(attempt)), attemptTimeout, signal);
      } else {
        return await fn(attempt);
      }
    } catch (error) {
      lastError = error;

      // Don't retry abort errors
      if (error instanceof AbortError) {
        throw error;
      }

      // Check if we should retry
      const retriesLeft = retries + 1 - attempt;
      const isLastAttempt = retriesLeft === 0;

      if (isLastAttempt) {
        throw error;
      }

      // Calculate next delay
      const nextDelay = calculateDelay(attempt, minTimeout, maxTimeout, factor, jitter);

      const context: RetryContext = {
        attempt,
        retriesLeft,
        elapsed: Date.now() - startTime,
        nextDelay,
      };

      // Check retryIf predicate
      if (retryIf) {
        const shouldRetry = await retryIf(error, context);
        if (!shouldRetry) {
          throw error;
        }
      }

      // Call onRetry callback
      if (onRetry) {
        await onRetry(error, context);
      }

      // Check if we have time for another attempt
      if (totalTimeout !== undefined) {
        const timeRemaining = totalTimeout - (Date.now() - startTime);
        if (timeRemaining < nextDelay) {
          throw new TimeoutError(`Total timeout of ${totalTimeout}ms would be exceeded`);
        }
      }

      // Wait before next attempt
      await sleep(nextDelay, signal);
    }
  }

  // Should never reach here, but TypeScript needs this
  throw lastError;
}

/**
 * Create a retryable version of an async function.
 *
 * @param fn - The async function to wrap.
 * @param options - Default retry options (can be overridden per call).
 * @returns A function that automatically retries on failure.
 *
 * @example
 * ```typescript
 * const fetchWithRetry = retryable(fetchData, { retries: 3 });
 * const result = await fetchWithRetry();
 * ```
 */
export function retryable<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult | Promise<TResult>,
  options: RetryOptions<TResult> = {}
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => retry(() => fn(...args), options);
}

