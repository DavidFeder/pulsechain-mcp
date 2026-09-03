import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      all: true,
      include: [
        "src/wallet/**/*.ts",
        "src/utils/confirm.ts",
        "src/tools/analytics/helpers.ts",
      ],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      // Measured 2026-09-03: stmts 83.18 / branches 77.82 / funcs 94.21 / lines 83.18
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 90,
        lines: 80,
      },
    },
  },
});
