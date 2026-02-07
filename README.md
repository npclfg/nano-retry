# nano-retry

Tiny retry with exponential backoff, jitter, timeout, and AbortSignal support.

- **Zero dependencies**
- **TypeScript-first** with full type inference
- **~150 lines** of code
- **ESM and CommonJS** support

## Why nano-retry?

| Feature | p-retry | async-retry | nano-retry |
|---------|---------|-------------|------------|
| Native TypeScript | ✅ | ❌ (needs @types) | ✅ |
| ESM + CJS | ESM-only (v6+) | CJS only | ✅ Both |
| Per-attempt timeout | ❌ | ❌ | ✅ |
| Total timeout | ✅ | ❌ | ✅ |
| AbortSignal | ✅ | ❌ | ✅ |
| Jitter (default) | opt-in | opt-in | ✅ on by default |
| Bail mechanism | AbortError class | bail() callback | retryIf predicate |

## Installation

```bash
npm install nano-retry
```

**Requirements:** Node.js 16+ or modern browsers (ES2020)

## Quick Start

```javascript
import { retry } from "nano-retry";

// Basic usage
const data = await retry(() => fetch("/api/data"));

// With options
const result = await retry(
  async (attempt) => {
    console.log(`Attempt ${attempt}`);
    return await fetchWithTimeout("/api/data");
  },
  {
    retries: 5,
    minTimeout: 1000,
    retryIf: (error) => error.status === 429 || error.status >= 500,
    onRetry: (error, ctx) => console.log(`Retrying in ${ctx.nextDelay}ms...`),
  }
);
```

### CommonJS

```javascript
const { retry } = require("nano-retry");
```

## API Reference

### `retry(fn, options?): Promise<T>`

Retry an async function with exponential backoff.

```typescript
const result = await retry(
  (attempt) => fetchData(), // attempt is 1-based
  { retries: 3 }
);
```

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `retries` | `number` | `3` | Maximum retry attempts (not counting initial) |
| `minTimeout` | `number` | `1000` | Initial delay in ms |
| `maxTimeout` | `number` | `30000` | Maximum delay in ms |
| `factor` | `number` | `2` | Exponential backoff multiplier |
| `jitter` | `boolean` | `true` | Add ±25% randomization to delays |
| `attemptTimeout` | `number` | - | Timeout for each attempt in ms |
| `totalTimeout` | `number` | - | Max total time for all attempts in ms |
| `signal` | `AbortSignal` | - | Cancel the retry operation |
| `retryIf` | `(error, ctx) => boolean` | - | Return `false` to stop retrying |
| `onRetry` | `(error, ctx) => void` | - | Called before each retry |

#### RetryContext

The `retryIf` and `onRetry` callbacks receive a context object:

```typescript
interface RetryContext {
  attempt: number;     // Current attempt (1-based)
  retriesLeft: number; // Remaining retries
  elapsed: number;     // Total elapsed time in ms
  nextDelay: number;   // Delay before next retry
}
```

### `retryable(fn, options?): WrappedFunction`

Create a pre-configured retryable function.

```typescript
const fetchWithRetry = retryable(
  (url: string) => fetch(url),
  { retries: 3, minTimeout: 500 }
);

const data = await fetchWithRetry("/api/users");
```

### Error Types

#### `AbortError`

Thrown when the operation is cancelled via AbortSignal.

```typescript
import { AbortError } from "nano-retry";

try {
  await retry(fn, { signal: controller.signal });
} catch (error) {
  if (error instanceof AbortError) {
    console.log("Operation was cancelled");
  }
}
```

#### `TimeoutError`

Thrown when `attemptTimeout` or `totalTimeout` is exceeded.

```typescript
import { TimeoutError } from "nano-retry";

try {
  await retry(fn, { attemptTimeout: 5000 });
} catch (error) {
  if (error instanceof TimeoutError) {
    console.log("Operation timed out");
  }
}
```

## Patterns & Recipes

### Rate Limit Handling (429)

```typescript
const result = await retry(
  () => callApi(),
  {
    retries: 5,
    minTimeout: 1000,
    retryIf: (error) => error.status === 429,
  }
);
```

### Retry Only Server Errors

```typescript
await retry(fetchData, {
  retryIf: (error) => {
    // Retry 5xx and network errors, not 4xx
    if (error.status >= 500) return true;
    if (error.code === "ECONNRESET") return true;
    return false;
  },
});
```

### With Per-Attempt Timeout

```typescript
// Each attempt has 5 seconds to complete
await retry(
  () => slowOperation(),
  {
    retries: 3,
    attemptTimeout: 5000,
  }
);
```

### With Total Timeout

```typescript
// Entire operation must complete within 30 seconds
await retry(
  () => fetchData(),
  {
    retries: 10,
    totalTimeout: 30000,
  }
);
```

### Cancellation with AbortController

```typescript
const controller = new AbortController();

// Cancel after 10 seconds
setTimeout(() => controller.abort(), 10000);

try {
  await retry(fetchData, { signal: controller.signal });
} catch (error) {
  if (error.name === "AbortError") {
    console.log("Cancelled");
  }
}
```

### Logging Retries

```typescript
await retry(fetchData, {
  onRetry: (error, ctx) => {
    console.log(
      `Attempt ${ctx.attempt} failed: ${error.message}. ` +
      `Retrying in ${ctx.nextDelay}ms (${ctx.retriesLeft} left)`
    );
  },
});
```

### Database with Transient Errors

```typescript
const RETRYABLE_CODES = new Set(["40001", "40P01", "ECONNRESET"]);

await retry(
  () => db.query("SELECT * FROM users"),
  {
    retries: 3,
    minTimeout: 100,
    retryIf: (error) => RETRYABLE_CODES.has(error.code),
  }
);
```

## TypeScript Usage

Full type inference is supported:

```typescript
import { retry, RetryOptions, RetryContext } from "nano-retry";

interface User {
  id: string;
  name: string;
}

// Return type is inferred as Promise<User>
const user = await retry(async (): Promise<User> => {
  const res = await fetch("/api/user");
  return res.json();
});
```

## Performance

nano-retry is optimized for the common case (no retries needed):

| Operation | Time |
|-----------|------|
| Direct call (baseline) | 0.10 µs |
| retry() - success | 0.22 µs |
| Overhead | **0.12 µs** |

The library adds minimal overhead when your function succeeds on the first attempt.

## Comparison with p-retry

### Simpler error handling

**p-retry** requires importing and throwing a special `AbortError`:

```typescript
// p-retry
import pRetry, { AbortError } from "p-retry";

await pRetry(async () => {
  const error = await getError();
  if (error.status === 400) {
    throw new AbortError("Bad request"); // Stop retrying
  }
});
```

**nano-retry** uses a simple predicate:

```typescript
// nano-retry
await retry(getError, {
  retryIf: (error) => error.status !== 400, // false = stop
});
```

### Per-attempt timeout

**p-retry** doesn't support per-attempt timeouts. You need to handle it yourself:

```typescript
// p-retry - manual timeout
await pRetry(async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5000);
  return fetch(url, { signal: controller.signal });
});
```

**nano-retry** has built-in support:

```typescript
// nano-retry - built-in
await retry(() => fetch(url), { attemptTimeout: 5000 });
```

## Development

```bash
npm install
npm run build    # Compile TypeScript (CJS + ESM)
npm test         # Run tests (45 tests)
npm run bench    # Run benchmarks
npm run verify   # Run all checks
```

## License

MIT
