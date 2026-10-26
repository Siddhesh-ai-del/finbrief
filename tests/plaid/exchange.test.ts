/**
 * Step 1.2 — public-token exchange against a scratch database.
 *
 * The plan's contract: `access_token` + `item_id` are encrypted at
 * rest, and they never appear in logs, traces, or API responses.
 * Phase 1's only output surfaces are console + stdio (the OTel
 * pipeline lands in a later phase), so the capture hooks every
 * emitter that exists today; the DTO and raw-row assertions cover
 * the response and storage paths.
 */
import { randomBytes } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Pool } from "pg";
import type {
  ItemPublicTokenExchangeRequest,
  ItemPublicTokenExchangeResponse,
} from "plaid";
import { createScratchDatabase } from "../helpers/scratch-db";
import { createDb, type Db } from "../../src/db/tenancy";
import {
  ExchangeInputError,
  ExchangeUpstreamError,
  ItemAlreadyLinkedError,
  createItemExchange,
  type PublicTokenExchangeClient,
} from "../../src/plaid/exchange";
import { ENCRYPTION_KEY_BYTES, createSecretBox } from "../../src/plaid/secrets";

const DB = "finbrief_plaid_exchange_test";
const PLAINTEXT_ITEM = "plaid-item-identifier-0001";
const PLAINTEXT_ACCESS = "plaid-access-credential-0001";
const PUBLIC_TOKEN_FIXTURE = "public-token-fixture-0001";
const ROOT_KEY = randomBytes(ENCRYPTION_KEY_BYTES).toString("base64");
const ORG_A = "org_exchange_a";
const ORG_B = "org_exchange_b";

interface ExchangeMock {
  client: PublicTokenExchangeClient;
  calls: ItemPublicTokenExchangeRequest[];
}

function createExchangeMock(
  payload?: Partial<ItemPublicTokenExchangeResponse>,
): ExchangeMock {
  const calls: ItemPublicTokenExchangeRequest[] = [];
  const data = (payload ?? {
    access_token: PLAINTEXT_ACCESS,
    item_id: PLAINTEXT_ITEM,
  }) as ItemPublicTokenExchangeResponse;
  return {
    calls,
    client: {
      itemPublicTokenExchange: async (params) => {
        calls.push(params);
        return { data };
      },
    },
  };
}

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let pool: Pool;
let db: Db;
const secrets = createSecretBox(ROOT_KEY);
let mock: ExchangeMock;
let items: ReturnType<typeof createItemExchange>;

const storedCount = async (): Promise<number> => {
  const res = await pool.query("SELECT count(*)::int AS n FROM plaid_items");
  return (res.rows[0] as { n: number }).n;
};

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  pool = scratch.pool;
  db = createDb(pool);

  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO organization (id, name, slug, created_at) VALUES
       ($1, 'Org A', 'exch-org-a', $3),
       ($2, 'Org B', 'exch-org-b', $3)`,
    [ORG_A, ORG_B, now],
  );
}, 60_000);

afterAll(async () => {
  await scratch?.destroy();
});

beforeEach(async () => {
  mock = createExchangeMock();
  items = createItemExchange({ client: mock.client, secrets });
  await pool.query("TRUNCATE plaid_items");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("encrypted persistence", () => {
  it("stores both credentials as ciphertext with a keyed lookup index", async () => {
    const stored = await items.exchange(db, {
      organizationId: ORG_A,
      publicToken: PUBLIC_TOKEN_FIXTURE,
    });

    expect(mock.calls).toEqual([{ public_token: PUBLIC_TOKEN_FIXTURE }]);

    const res = await pool.query("SELECT * FROM plaid_items WHERE id = $1", [
      stored.id,
    ]);
    const row = res.rows[0] as {
      organization_id: string;
      item_id_ciphertext: string;
      access_token_ciphertext: string;
      item_id_index: string;
    };

    expect(row.organization_id).toBe(ORG_A);
    expect(row.item_id_ciphertext).not.toContain(PLAINTEXT_ITEM);
    expect(row.access_token_ciphertext).not.toContain(PLAINTEXT_ACCESS);
    expect(secrets.decrypt(row.item_id_ciphertext)).toBe(PLAINTEXT_ITEM);
    expect(secrets.decrypt(row.access_token_ciphertext)).toBe(PLAINTEXT_ACCESS);
    expect(row.item_id_index).toBe(secrets.index(PLAINTEXT_ITEM));
    expect(row.item_id_index).not.toContain(PLAINTEXT_ITEM);
  });

  it("returns a DTO whose every field is credential-free", async () => {
    const stored = await items.exchange(db, {
      organizationId: ORG_A,
      publicToken: PUBLIC_TOKEN_FIXTURE,
    });

    expect(Object.keys(stored).sort()).toEqual([
      "createdAt",
      "id",
      "organizationId",
    ]);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(PLAINTEXT_ITEM);
    expect(serialized).not.toContain(PLAINTEXT_ACCESS);
  });
});

describe("negative surface: nothing leaves the module", () => {
  it("emits no credential material to captured console or stdio output", async () => {
    const captured: string[] = [];
    (["log", "info", "warn", "error", "debug", "trace"] as const).forEach(
      (method) => {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          captured.push(`${method}:${JSON.stringify(args)}`);
        });
      },
    );
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      captured.push(`stdout:${String(chunk)}`);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      captured.push(`stderr:${String(chunk)}`);
      return true;
    });

    const stored = await items.exchange(db, {
      organizationId: ORG_A,
      publicToken: PUBLIC_TOKEN_FIXTURE,
    });

    const haystack = [...captured, JSON.stringify(stored)].join(" ");
    expect(haystack).not.toContain(PLAINTEXT_ITEM);
    expect(haystack).not.toContain(PLAINTEXT_ACCESS);
  });
});

describe("idempotency and tenant conflicts", () => {
  it("re-exchange by the same organization claims the same row", async () => {
    const first = await items.exchange(db, {
      organizationId: ORG_A,
      publicToken: PUBLIC_TOKEN_FIXTURE,
    });
    const second = await items.exchange(db, {
      organizationId: ORG_A,
      publicToken: PUBLIC_TOKEN_FIXTURE,
    });

    expect(second.id).toBe(first.id);
    expect(mock.calls).toHaveLength(2); // upstream repeats; the DB dedupes
    expect(await storedCount()).toBe(1);
  });

  it("refuses an item already claimed by another organization", async () => {
    await items.exchange(db, {
      organizationId: ORG_A,
      publicToken: PUBLIC_TOKEN_FIXTURE,
    });

    let message = "";
    try {
      await items.exchange(db, {
        organizationId: ORG_B,
        publicToken: PUBLIC_TOKEN_FIXTURE,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ItemAlreadyLinkedError);
      message = String(error);
    }
    expect(message).not.toContain(PLAINTEXT_ITEM);
    expect(message).not.toContain(PLAINTEXT_ACCESS);

    const foreign = await pool.query(
      "SELECT count(*)::int AS n FROM plaid_items WHERE organization_id = $1",
      [ORG_B],
    );
    expect((foreign.rows[0] as { n: number }).n).toBe(0);
    expect(await storedCount()).toBe(1);
  });
});

describe("input validation (table-driven)", () => {
  const cases: { name: string; organizationId: string; publicToken: string }[] =
    [
      { name: "empty public token", organizationId: ORG_A, publicToken: "" },
      {
        name: "whitespace-only public token",
        organizationId: ORG_A,
        publicToken: "   ",
      },
      {
        name: "missing organization id",
        organizationId: "",
        publicToken: PUBLIC_TOKEN_FIXTURE,
      },
    ];

  for (const testCase of cases) {
    it(`rejects ${testCase.name} before any upstream call`, async () => {
      await expect(
        items.exchange(db, {
          organizationId: testCase.organizationId,
          publicToken: testCase.publicToken,
        }),
      ).rejects.toThrow(ExchangeInputError);
      expect(mock.calls).toHaveLength(0);
      expect(await storedCount()).toBe(0);
    });
  }
});

describe("upstream contract", () => {
  it("fails closed when the exchange payload is incomplete", async () => {
    mock = createExchangeMock({ item_id: PLAINTEXT_ITEM });
    items = createItemExchange({ client: mock.client, secrets });

    await expect(
      items.exchange(db, {
        organizationId: ORG_A,
        publicToken: PUBLIC_TOKEN_FIXTURE,
      }),
    ).rejects.toThrow(ExchangeUpstreamError);
    expect(await storedCount()).toBe(0);
  });
});
