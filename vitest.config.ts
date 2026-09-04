import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    coverage: { provider: "v8", include: ["packages/*/src/**", "apps/*/src/**"] },
  },
});
