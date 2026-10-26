import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config (generate/migrate). `generate` needs no
 * connection; `migrate` (used by the vitest global setup and
 * `npm run db:migrate`) takes the target from DATABASE_URL.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  strict: true,
  verbose: true,
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      process.env.TEST_DATABASE_URL ??
      "postgres://localhost:5432/finbrief_dev",
  },
});
