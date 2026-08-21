import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@lbc/contracts": resolve(__dirname, "packages/contracts/src/index.ts"),
      "@lbc/fixtures": resolve(__dirname, "packages/fixtures/src/index.ts"),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
  },
});
