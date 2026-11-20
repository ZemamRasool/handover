import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // Integration tests share one database, so run files one at a time.
    fileParallelism: false,
    // The test database is a remote Supabase project (ap-southeast-2), so every
    // query is a round trip; the 5s default is not enough for the longer flows.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
