import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The three property tests (cycles/public-surface/type-leak) run ~25
    // real cases each, ~4-5s idle - fine alone, but they hit vitest's own
    // 20s timeout under a shared machine's real CPU contention, even though
    // the whole suite passes serially in well under a minute. Measured: the
    // marginal cause is vitest's own cross-file worker pool competing for
    // CPU, not these tests' own cost - serializing files removes exactly
    // that contention, rather than papering over it with a longer timeout
    // or (which would weaken what the properties actually cover) fewer
    // cases.
    fileParallelism: false,
    // test/cli.test.ts spawns 1-3 cold `node dist/cli.js` processes per test,
    // each building a real TypeScript Program - measured to occasionally
    // exceed vitest's 5000ms default on CI hardware even though every one
    // completes in well under a second locally.
    testTimeout: 15000,
  },
});
