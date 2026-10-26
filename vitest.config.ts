import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // JSX transform — tsconfig uses `jsx: "preserve"` for Next.js, so Vitest
  // needs the React plugin to compile JSX in .tsx tests.
  plugins: [react()],
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    // Globals let @testing-library/react register its auto-cleanup afterEach,
    // preventing DOM leaks between tests in the same file.
    globals: true,
    coverage: {
      provider: "v8",
      // Coverage gate: the plan mandates >=80% per module (Phase 0.1).
      // CI fails the build below this — see .github/workflows/ci.yml.
      thresholds: {
        statements: 80,
        lines: 80,
        functions: 80,
        branches: 80,
      },
      include: ["src/**"],
      // App Router route handlers and pages are exercised by unit tests
      // where practical, by Playwright E2E (Phase 6.1) end-to-end.
      exclude: ["src/app/**/route.ts"],
      reporter: ["text", "lcov", "json-summary"],
    },
  },
  resolve: {
    alias: {
      "@": new URL("./src/", import.meta.url).pathname,
    },
  },
});
