const { retry } = require("../dist/cjs/retry");

async function bench(name, iterations, fn) {
  // Warmup
  for (let i = 0; i < 100; i++) await fn();

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    await fn();
  }
  const end = process.hrtime.bigint();
  const totalNs = Number(end - start);
  const perOpNs = totalNs / iterations;
  const perOpUs = perOpNs / 1000;
  console.log(`${name}: ${perOpUs.toFixed(2)} µs/op`);
}

async function main() {
  const iterations = Number(process.env.ITERATIONS || 10000);
  console.log(`Iterations: ${iterations}\n`);

  // Baseline: direct function call
  await bench("Direct call (baseline)", iterations, async () => {
    return "success";
  });

  // Retry with immediate success (no retries needed)
  await bench("retry() - immediate success", iterations, async () => {
    return retry(() => "success", { retries: 3 });
  });

  // Retry with immediate success, all options
  await bench("retry() - with all options", iterations, async () => {
    return retry(() => "success", {
      retries: 3,
      minTimeout: 100,
      maxTimeout: 1000,
      factor: 2,
      jitter: true,
      retryIf: () => true,
      onRetry: () => {},
    });
  });

  // Retry with one failure (minimal delay)
  await bench("retry() - 1 failure, 1ms delay", iterations / 10, async () => {
    let calls = 0;
    return retry(
      () => {
        calls++;
        if (calls === 1) throw new Error("fail");
        return "success";
      },
      { retries: 1, minTimeout: 1, jitter: false }
    );
  });

  console.log("\nNote: Retry overhead is minimal for success cases.");
  console.log("The library is optimized for the common path (no retries needed).");
}

main().catch(console.error);
