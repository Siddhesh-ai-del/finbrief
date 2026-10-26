/**
 * Better Auth wiring (Phase 0.3) — email/password sessions plus the
 * organization plugin, over the Drizzle schema from Step 0.2.
 *
 * The factory takes an explicit secret (or BETTER_AUTH_SECRET) and
 * refuses to build without one — no silent default credentials, ever.
 * `tests/auth/auth-flows.test.ts` pins the isolation behavior this
 * configuration must provide.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { schema } from "../db/schema";

export interface CreateAuthOptions {
  /** Explicit secret; falls back to BETTER_AUTH_SECRET. Required either way. */
  secret?: string;
  /** Explicit base URL; falls back to BETTER_AUTH_URL, then localhost. */
  baseURL?: string;
}

function resolveSecret(explicit: string | undefined): string {
  const secret = explicit ?? process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Better Auth secret is required: pass options.secret or set BETTER_AUTH_SECRET",
    );
  }
  return secret;
}

function resolveBaseUrl(explicit: string | undefined): string {
  return explicit ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
}

/** Build the auth instance bound to a Postgres pool and our schema. */
export function createAuth(pool: Pool, options: CreateAuthOptions = {}) {
  const db = drizzle(pool, { schema });
  return betterAuth({
    baseURL: resolveBaseUrl(options.baseURL),
    secret: resolveSecret(options.secret),
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    plugins: [organization()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
