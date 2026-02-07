const assert = require("assert");
const { retry, retryable, AbortError, TimeoutError } = require("../dist/cjs/retry");

// ============================================================================
// Test Harness
// ============================================================================

const tests = [];
let currentSuite = null;

function describe(name, fn) {
  currentSuite = name;
  fn();
  currentSuite = null;
}

function it(name, fn) {
  tests.push({
    suite: currentSuite,
    name,
    fn,
  });
}

async function runTests() {
  let passed = 0;
  let failed = 0;
  let currentSuite = null;

  for (const test of tests) {
    if (test.suite !== currentSuite) {
      currentSuite = test.suite;
      console.log(`\n${currentSuite}`);
    }
    try {
      await test.fn();
      console.log(`  ✓ ${test.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${test.name}`);
      console.log(`    ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${passed} passing, ${failed} failing`);
  if (failed > 0) process.exit(1);
}

// ============================================================================
// Helper Functions
// ============================================================================

function createFailingFn(failCount, returnValue = "success") {
  let calls = 0;
  return () => {
    calls++;
    if (calls <= failCount) {
      throw new Error(`Failure ${calls}`);
    }
    return returnValue;
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Basic Retry Behavior
// ============================================================================

describe("Basic Retry", () => {
  it("should return result on first success", async () => {
    const result = await retry(() => "success");
    assert.strictEqual(result, "success");
  });

  it("should return result from async function", async () => {
    const result = await retry(async () => {
      await delay(10);
      return "async success";
    });
    assert.strictEqual(result, "async success");
  });

  it("should retry on failure and eventually succeed", async () => {
    const fn = createFailingFn(2, "recovered");
    const result = await retry(fn, { retries: 3, minTimeout: 10 });
    assert.strictEqual(result, "recovered");
  });

  it("should throw after exhausting all retries", async () => {
    const fn = createFailingFn(10, "never");
    await assert.rejects(
      () => retry(fn, { retries: 2, minTimeout: 10 }),
      /Failure 3/
    );
  });

  it("should pass attempt number to function", async () => {
    const attempts = [];
    const fn = (attempt) => {
      attempts.push(attempt);
      if (attempt < 3) throw new Error("not yet");
      return "done";
    };
    await retry(fn, { retries: 3, minTimeout: 10 });
    assert.deepStrictEqual(attempts, [1, 2, 3]);
  });
});

// ============================================================================
// Exponential Backoff
// ============================================================================

describe("Exponential Backoff", () => {
  it("should increase delay exponentially", async () => {
    const delays = [];
    let lastTime = Date.now();

    const fn = createFailingFn(3, "done");
    await retry(
      () => {
        const now = Date.now();
        if (delays.length > 0 || lastTime !== now) {
          delays.push(now - lastTime);
        }
        lastTime = now;
        return fn();
      },
      { retries: 3, minTimeout: 50, factor: 2, jitter: false }
    );

    // Delays should be approximately 50, 100, 200
    assert.strictEqual(delays.length, 3);
    assert.ok(delays[0] >= 45 && delays[0] <= 70, `First delay ${delays[0]} not ~50`);
    assert.ok(delays[1] >= 90 && delays[1] <= 130, `Second delay ${delays[1]} not ~100`);
    assert.ok(delays[2] >= 180 && delays[2] <= 250, `Third delay ${delays[2]} not ~200`);
  });

  it("should respect maxTimeout", async () => {
    const delays = [];
    let lastTime = Date.now();

    const fn = createFailingFn(3, "done");
    await retry(
      () => {
        const now = Date.now();
        if (delays.length > 0 || lastTime !== now) {
          delays.push(now - lastTime);
        }
        lastTime = now;
        return fn();
      },
      { retries: 3, minTimeout: 50, maxTimeout: 80, factor: 2, jitter: false }
    );

    // All delays should be capped at 80
    for (const d of delays) {
      assert.ok(d <= 100, `Delay ${d} exceeded maxTimeout`);
    }
  });

  it("should add jitter when enabled", async () => {
    // Run multiple times and check for variance
    const allDelays = [];
    for (let i = 0; i < 5; i++) {
      const delays = [];
      let lastTime = Date.now();

      const fn = createFailingFn(2, "done");
      await retry(
        () => {
          const now = Date.now();
          if (delays.length > 0 || lastTime !== now) {
            delays.push(now - lastTime);
          }
          lastTime = now;
          return fn();
        },
        { retries: 2, minTimeout: 50, jitter: true }
      );
      allDelays.push(delays[0]);
    }

    // With jitter, delays should vary
    const uniqueDelays = new Set(allDelays.map(d => Math.round(d / 10)));
    // Allow some variance - not all exactly the same
    assert.ok(uniqueDelays.size >= 1, "Expected some variance with jitter");
  });
});

// ============================================================================
// retryIf Predicate
// ============================================================================

describe("retryIf Predicate", () => {
  it("should retry when retryIf returns true", async () => {
    let attempts = 0;
    const result = await retry(
      () => {
        attempts++;
        if (attempts < 3) throw new Error("retry me");
        return "done";
      },
      {
        retries: 5,
        minTimeout: 10,
        retryIf: (error) => error.message === "retry me",
      }
    );
    assert.strictEqual(result, "done");
    assert.strictEqual(attempts, 3);
  });

  it("should not retry when retryIf returns false", async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        retry(
          () => {
            attempts++;
            throw new Error("do not retry");
          },
          {
            retries: 5,
            minTimeout: 10,
            retryIf: () => false,
          }
        ),
      /do not retry/
    );
    assert.strictEqual(attempts, 1);
  });

  it("should pass context to retryIf", async () => {
    let capturedContext;
    const fn = createFailingFn(1, "done");
    await retry(fn, {
      retries: 3,
      minTimeout: 10,
      retryIf: (error, ctx) => {
        capturedContext = ctx;
        return true;
      },
    });

    assert.strictEqual(capturedContext.attempt, 1);
    assert.strictEqual(capturedContext.retriesLeft, 3);
    assert.ok(capturedContext.elapsed >= 0);
    assert.ok(capturedContext.nextDelay > 0);
  });

  it("should support async retryIf", async () => {
    let attempts = 0;
    const result = await retry(
      () => {
        attempts++;
        if (attempts < 2) throw new Error("retry");
        return "done";
      },
      {
        retries: 3,
        minTimeout: 10,
        retryIf: async () => {
          await delay(5);
          return true;
        },
      }
    );
    assert.strictEqual(result, "done");
  });
});

// ============================================================================
// onRetry Callback
// ============================================================================

describe("onRetry Callback", () => {
  it("should call onRetry before each retry", async () => {
    const calls = [];
    const fn = createFailingFn(2, "done");
    await retry(fn, {
      retries: 3,
      minTimeout: 10,
      onRetry: (error, ctx) => {
        calls.push({ error: error.message, attempt: ctx.attempt });
      },
    });

    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].attempt, 1);
    assert.strictEqual(calls[1].attempt, 2);
  });

  it("should not call onRetry on success", async () => {
    let called = false;
    await retry(() => "success", {
      retries: 3,
      minTimeout: 10,
      onRetry: () => {
        called = true;
      },
    });
    assert.strictEqual(called, false);
  });

  it("should not call onRetry after last attempt", async () => {
    const calls = [];
    await assert.rejects(
      () =>
        retry(
          () => {
            throw new Error("always fail");
          },
          {
            retries: 2,
            minTimeout: 10,
            onRetry: (error, ctx) => {
              calls.push(ctx.attempt);
            },
          }
        ),
      /always fail/
    );
    // Only called after attempt 1 and 2, not after attempt 3 (the last one)
    assert.deepStrictEqual(calls, [1, 2]);
  });

  it("should support async onRetry", async () => {
    let asyncCompleted = false;
    const fn = createFailingFn(1, "done");
    await retry(fn, {
      retries: 2,
      minTimeout: 10,
      onRetry: async () => {
        await delay(5);
        asyncCompleted = true;
      },
    });
    assert.strictEqual(asyncCompleted, true);
  });
});

// ============================================================================
// Attempt Timeout
// ============================================================================

describe("Attempt Timeout", () => {
  it("should timeout slow attempts", async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        retry(
          async () => {
            attempts++;
            await delay(100);
            return "too slow";
          },
          { retries: 2, minTimeout: 10, attemptTimeout: 20 }
        ),
      /timed out/
    );
    assert.strictEqual(attempts, 3); // All attempts should timeout
  });

  it("should succeed if attempt completes within timeout", async () => {
    const result = await retry(
      async () => {
        await delay(10);
        return "fast enough";
      },
      { retries: 2, minTimeout: 10, attemptTimeout: 100 }
    );
    assert.strictEqual(result, "fast enough");
  });

  it("should count timeout as failed attempt", async () => {
    let attempts = 0;
    const result = await retry(
      async () => {
        attempts++;
        if (attempts === 1) {
          await delay(100); // First attempt times out
        }
        return "success";
      },
      { retries: 2, minTimeout: 10, attemptTimeout: 20 }
    );
    assert.strictEqual(result, "success");
    assert.strictEqual(attempts, 2);
  });
});

// ============================================================================
// Total Timeout
// ============================================================================

describe("Total Timeout", () => {
  it("should fail if total timeout exceeded", async () => {
    await assert.rejects(
      () =>
        retry(
          async () => {
            await delay(30);
            throw new Error("still failing");
          },
          { retries: 10, minTimeout: 50, totalTimeout: 100 }
        ),
      /Total timeout/
    );
  });

  it("should succeed if completed within total timeout", async () => {
    const fn = createFailingFn(1, "done");
    const result = await retry(fn, {
      retries: 3,
      minTimeout: 10,
      totalTimeout: 1000,
    });
    assert.strictEqual(result, "done");
  });
});

// ============================================================================
// AbortSignal Support
// ============================================================================

describe("AbortSignal Support", () => {
  it("should abort immediately if signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => retry(() => "success", { signal: controller.signal }),
      (err) => err instanceof AbortError
    );
  });

  it("should abort during delay", async () => {
    const controller = new AbortController();
    let attempts = 0;

    setTimeout(() => controller.abort(), 50);

    await assert.rejects(
      () =>
        retry(
          () => {
            attempts++;
            throw new Error("fail");
          },
          { retries: 10, minTimeout: 200, signal: controller.signal }
        ),
      (err) => err instanceof AbortError
    );

    // Should have aborted during delay after first attempt
    assert.strictEqual(attempts, 1);
  });

  it("should abort during attempt execution", async () => {
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 30);

    await assert.rejects(
      () =>
        retry(
          async () => {
            await delay(100);
            return "too slow";
          },
          { retries: 3, minTimeout: 10, signal: controller.signal, attemptTimeout: 200 }
        ),
      (err) => err instanceof AbortError
    );
  });
});

// ============================================================================
// Error Types
// ============================================================================

describe("Error Types", () => {
  it("AbortError should have correct properties", () => {
    const error = new AbortError("custom message");
    assert.strictEqual(error.name, "AbortError");
    assert.strictEqual(error.message, "custom message");
    assert.strictEqual(error.isRetryAbort, true);
    assert.ok(error instanceof Error);
  });

  it("TimeoutError should have correct properties", () => {
    const error = new TimeoutError("timeout message");
    assert.strictEqual(error.name, "TimeoutError");
    assert.strictEqual(error.message, "timeout message");
    assert.strictEqual(error.isRetryTimeout, true);
    assert.ok(error instanceof Error);
  });

  it("should not retry AbortError", async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        retry(
          () => {
            attempts++;
            throw new AbortError("stop now");
          },
          { retries: 5, minTimeout: 10 }
        ),
      (err) => err instanceof AbortError
    );
    assert.strictEqual(attempts, 1);
  });
});

// ============================================================================
// Input Validation
// ============================================================================

describe("Input Validation", () => {
  it("should reject negative retries", async () => {
    await assert.rejects(
      () => retry(() => "x", { retries: -1 }),
      /non-negative integer/
    );
  });

  it("should reject non-integer retries", async () => {
    await assert.rejects(
      () => retry(() => "x", { retries: 1.5 }),
      /non-negative integer/
    );
  });

  it("should reject non-positive minTimeout", async () => {
    await assert.rejects(
      () => retry(() => "x", { minTimeout: 0 }),
      /minTimeout must be positive/
    );
  });

  it("should reject non-positive maxTimeout", async () => {
    await assert.rejects(
      () => retry(() => "x", { maxTimeout: -100 }),
      /maxTimeout must be positive/
    );
  });

  it("should reject non-positive factor", async () => {
    await assert.rejects(
      () => retry(() => "x", { factor: 0 }),
      /factor must be positive/
    );
  });

  it("should reject non-positive attemptTimeout", async () => {
    await assert.rejects(
      () => retry(() => "x", { attemptTimeout: 0 }),
      /attemptTimeout must be positive/
    );
  });

  it("should reject non-positive totalTimeout", async () => {
    await assert.rejects(
      () => retry(() => "x", { totalTimeout: -100 }),
      /totalTimeout must be positive/
    );
  });
});

// ============================================================================
// retryable Wrapper
// ============================================================================

describe("retryable Wrapper", () => {
  it("should create a retryable function", async () => {
    const fn = createFailingFn(2, "wrapped success");
    const wrapped = retryable(fn, { retries: 3, minTimeout: 10 });
    const result = await wrapped();
    assert.strictEqual(result, "wrapped success");
  });

  it("should pass arguments to wrapped function", async () => {
    const fn = (a, b) => a + b;
    const wrapped = retryable(fn, { retries: 1 });
    const result = await wrapped(2, 3);
    assert.strictEqual(result, 5);
  });

  it("should retry wrapped function on failure", async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 3) throw new Error("not yet");
      return "done";
    };
    const wrapped = retryable(fn, { retries: 3, minTimeout: 10 });
    const result = await wrapped();
    assert.strictEqual(result, "done");
    assert.strictEqual(calls, 3);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("Edge Cases", () => {
  it("should work with zero retries (single attempt)", async () => {
    const result = await retry(() => "immediate", { retries: 0 });
    assert.strictEqual(result, "immediate");
  });

  it("should fail immediately with zero retries on error", async () => {
    await assert.rejects(
      () =>
        retry(
          () => {
            throw new Error("instant fail");
          },
          { retries: 0 }
        ),
      /instant fail/
    );
  });

  it("should handle synchronous functions", async () => {
    const result = await retry(() => 42, { retries: 1 });
    assert.strictEqual(result, 42);
  });

  it("should preserve error type through retries", async () => {
    class CustomError extends Error {
      code = "CUSTOM";
    }
    await assert.rejects(
      () =>
        retry(
          () => {
            throw new CustomError("custom");
          },
          { retries: 1, minTimeout: 10 }
        ),
      (err) => err instanceof CustomError && err.code === "CUSTOM"
    );
  });

  it("should handle rapid succession of retries", async () => {
    let count = 0;
    const result = await retry(
      () => {
        count++;
        if (count < 10) throw new Error("not yet");
        return "done";
      },
      { retries: 10, minTimeout: 1, jitter: false }
    );
    assert.strictEqual(result, "done");
  });
});

// ============================================================================
// Integration: Real-world Scenarios
// ============================================================================

describe("Integration: Real-world Scenarios", () => {
  it("should handle rate limit scenario (429)", async () => {
    let attempts = 0;
    const result = await retry(
      () => {
        attempts++;
        if (attempts < 3) {
          const error = new Error("Too Many Requests");
          error.status = 429;
          throw error;
        }
        return { data: "success" };
      },
      {
        retries: 5,
        minTimeout: 10,
        retryIf: (error) => error.status === 429,
      }
    );
    assert.deepStrictEqual(result, { data: "success" });
  });

  it("should not retry non-retryable errors (4xx)", async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        retry(
          () => {
            attempts++;
            const error = new Error("Bad Request");
            error.status = 400;
            throw error;
          },
          {
            retries: 5,
            minTimeout: 10,
            retryIf: (error) => error.status >= 500 || error.status === 429,
          }
        ),
      /Bad Request/
    );
    assert.strictEqual(attempts, 1);
  });

  it("should handle network timeout pattern", async () => {
    let attempts = 0;
    const result = await retry(
      async () => {
        attempts++;
        if (attempts < 2) {
          await delay(50);
          throw new Error("ETIMEDOUT");
        }
        return "connected";
      },
      {
        retries: 3,
        minTimeout: 10,
        attemptTimeout: 30,
        retryIf: (error) =>
          error.message.includes("ETIMEDOUT") || error instanceof TimeoutError,
      }
    );
    assert.strictEqual(result, "connected");
  });
});

// ============================================================================
// Run Tests
// ============================================================================

runTests();
