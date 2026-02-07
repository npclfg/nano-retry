const { retry, retryable } = require("../dist/cjs/retry");

// Simulate an unreliable API
let apiCallCount = 0;
async function unreliableApi() {
  apiCallCount++;
  console.log(`  API call #${apiCallCount}`);

  // Fail first 2 calls with rate limit
  if (apiCallCount <= 2) {
    const error = new Error("Too Many Requests");
    error.status = 429;
    throw error;
  }

  return { data: "success", timestamp: Date.now() };
}

// Simulate a flaky database
let dbCallCount = 0;
async function flakyDatabase() {
  dbCallCount++;
  console.log(`  DB query #${dbCallCount}`);

  // Fail first call with transient error
  if (dbCallCount === 1) {
    const error = new Error("Connection reset");
    error.code = "ECONNRESET";
    throw error;
  }

  return { rows: [{ id: 1, name: "test" }] };
}

async function main() {
  console.log("=== nano-retry Sample App ===\n");

  // Example 1: Basic retry with rate limit handling
  console.log("1. API with rate limit retry:");
  try {
    const result = await retry(unreliableApi, {
      retries: 5,
      minTimeout: 100,
      retryIf: (error) => error.status === 429,
      onRetry: (error, ctx) => {
        console.log(`  → Retry ${ctx.attempt}, waiting ${ctx.nextDelay}ms (${error.message})`);
      },
    });
    console.log(`  ✓ Success:`, result);
  } catch (error) {
    console.log(`  ✗ Failed:`, error.message);
  }

  console.log();

  // Example 2: Retryable wrapper for database
  console.log("2. Database with retryable wrapper:");
  const queryWithRetry = retryable(flakyDatabase, {
    retries: 3,
    minTimeout: 50,
    retryIf: (error) => error.code === "ECONNRESET",
    onRetry: (error, ctx) => {
      console.log(`  → Retry ${ctx.attempt} (${error.message})`);
    },
  });

  try {
    const result = await queryWithRetry();
    console.log(`  ✓ Success:`, result);
  } catch (error) {
    console.log(`  ✗ Failed:`, error.message);
  }

  console.log();

  // Example 3: With timeout
  console.log("3. Slow operation with attempt timeout:");
  let slowCallCount = 0;
  try {
    const result = await retry(
      async () => {
        slowCallCount++;
        console.log(`  Slow call #${slowCallCount}`);
        if (slowCallCount === 1) {
          await new Promise((r) => setTimeout(r, 200)); // Too slow
        }
        return "fast enough";
      },
      {
        retries: 2,
        minTimeout: 50,
        attemptTimeout: 100,
        onRetry: (error, ctx) => {
          console.log(`  → Retry ${ctx.attempt} (${error.message})`);
        },
      }
    );
    console.log(`  ✓ Success:`, result);
  } catch (error) {
    console.log(`  ✗ Failed:`, error.message);
  }

  console.log();

  // Example 4: AbortController
  console.log("4. Cancellable operation:");
  const controller = new AbortController();

  // Abort after 150ms
  setTimeout(() => {
    console.log("  → Aborting...");
    controller.abort();
  }, 150);

  try {
    await retry(
      async () => {
        console.log("  Attempting (will be cancelled)...");
        await new Promise((r) => setTimeout(r, 50));
        throw new Error("still failing");
      },
      {
        retries: 10,
        minTimeout: 100,
        signal: controller.signal,
      }
    );
  } catch (error) {
    console.log(`  ✓ Caught: ${error.name} - ${error.message}`);
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
