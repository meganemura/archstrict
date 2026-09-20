import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // test/cli.test.ts spawns 1-3 cold `node dist/cli.js` processes per test,
    // each building a real TypeScript Program - measured to occasionally
    // exceed vitest's 5000ms default on CI hardware even though every one
    // completes in well under a second locally.
    testTimeout: 15000,
  },
});
