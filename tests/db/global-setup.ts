/**
 * Vitest global setup — a real, throwaway Postgres per test run.
 *
 * - If TEST_DATABASE_URL is already set (GitHub Actions service
 *   container), use it as-is and run migrations against it.
 * - Otherwise start a fresh `postgres:17-alpine` container on an
 *   ephemeral loopback port, wait for readiness, point
 *   TEST_DATABASE_URL at it, and remove the container on teardown.
 *
 * Workers inherit TEST_DATABASE_URL through process.env; the tests
 * fail loudly if it is missing rather than silently skipping.
 */
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = process.cwd();
const DRIZZLE_KIT = path.join(REPO_ROOT, "node_modules", ".bin", "drizzle-kit");
const IMAGE = "postgres:17-alpine";

let startedContainer: string | null = null;

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function startContainer(): void {
  // Best-effort cleanup of leftovers from crashed previous runs.
  try {
    const stale = docker(["ps", "-aq", "--filter", "name=finbrief-pg-"]);
    if (stale) docker(["rm", "-f", ...stale.split("\n")]);
  } catch {
    /* ignore — docker may be briefly unavailable */
  }

  const name = `finbrief-pg-${process.pid}`;
  docker([
    "run",
    "-d",
    "--name",
    name,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_DB=finbrief_test",
    "-p",
    "127.0.0.1::5432",
    IMAGE,
  ]);
  startedContainer = name;

  const portLine = docker(["port", name, "5432/tcp"]).split("\n")[0] ?? "";
  const port = portLine.split(":").pop();
  if (!port) throw new Error(`could not determine mapped port: ${portLine}`);
  process.env.TEST_DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/finbrief_test`;

  // TCP readiness only: `pg_isready` over the unix socket answers
  // during the entrypoint's init phase, whose temp server then dies
  // and kills any connection made in that window.
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      execFileSync(
        "docker",
        ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
        { stdio: "ignore" },
      );
      return;
    } catch {
      execSyncSleep(500);
    }
  }
  throw new Error(`postgres container ${name} never became ready`);
}

function execSyncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Connection-class failures are retried; SQL errors fail fast. */
const TRANSIENT =
  /terminat|refused|ECONNRESET|ECONNREFUSED|starting up|not yet accepted/i;

function migrate(): void {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL missing before migrate");
  let lastOutput = "";
  for (let attempt = 1; attempt <= 30; attempt++) {
    const res = spawnSync(DRIZZLE_KIT, ["migrate"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: url },
    });
    if (res.status === 0) return;
    lastOutput = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    if (!TRANSIENT.test(lastOutput)) break;
    execSyncSleep(1000);
  }
  throw new Error(`drizzle-kit migrate failed:\n${lastOutput}`);
}

export async function setup(): Promise<void> {
  try {
    if (!process.env.TEST_DATABASE_URL) {
      startContainer();
    }
    migrate();
  } catch (err) {
    // Log raw before rethrowing: vitest's startup-error formatter can
    // crash on transformed stack frames and hide the real cause.
    console.error("[global-setup] FAILED:", err);
    throw err;
  }
}

export async function teardown(): Promise<void> {
  if (startedContainer) {
    try {
      docker(["rm", "-f", startedContainer]);
    } catch {
      /* best effort */
    }
    startedContainer = null;
  }
}
