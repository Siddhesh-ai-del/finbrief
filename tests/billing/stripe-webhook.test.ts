/**
 * Step 0.4 — Stripe webhook state machine: signature verification,
 * checkout → entitlement activation + included-credit grant,
 * refund/cancel → entitlement drop, and replay idempotency (the same
 * event id applies exactly one effect, ever).
 *
 * Signature helpers build the real `t=…,v1=…` HMAC header offline —
 * no network, no Stripe account, test mode only (plan §6.3-13 risk
 * note: Stripe US rates are UNVERIFIED; nothing fee-related appears
 * in runtime code — entitlement numbers come from injected config).
 */
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { createScratchDatabase } from "../helpers/scratch-db";
import { createDb, type Db } from "../../src/db/tenancy";
import {
  handleStripeWebhook,
  type BillingConfig,
} from "../../src/billing/stripe-webhook";

const DB = "finbrief_billing_webhook_test";
const ORG = "org_webhook_1";
const USER_ID = "user_webhook";
/** Webhook signing key fixture — test-mode value, never a live key. */
const SIGNING_KEY = "whsec_test_fixture_0001";
const PRICE_100 = "price_100_credits";

const CONFIG: BillingConfig = {
  prices: { [PRICE_100]: { plan: "pro_monthly", includedCredits: 100 } },
};

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let db: Db;
const stripe = new Stripe("sk_test_placeholder_not_a_real_key");

const deps = () => ({ stripe, db, webhookSecret: SIGNING_KEY, config: CONFIG });

function signPayload(
  payload: string,
  signingKey: string,
  offsetSeconds = 0,
): string {
  const t = Math.floor(Date.now() / 1000) + offsetSeconds;
  const mac = createHmac("sha256", signingKey)
    .update(`${t}.${payload}`)
    .digest("hex");
  return `t=${t},v1=${mac}`;
}

function checkoutPayload(opts: {
  eventId: string;
  priceId?: string;
  subscriptionId?: string;
  includeOrganization?: boolean;
}): string {
  const metadata: Record<string, string> = {
    priceId: opts.priceId ?? PRICE_100,
  };
  if (opts.includeOrganization !== false) {
    metadata.organizationId = ORG;
  }
  const object = {
    id: `cs_${opts.eventId}`,
    customer: "cus_test_1",
    subscription: opts.subscriptionId ?? "sub_test_1",
    metadata,
  };
  return JSON.stringify({
    id: opts.eventId,
    type: "checkout.session.completed",
    data: { object },
  });
}

const entitlementRows = async () => {
  const res = await scratch.pool.query(
    `SELECT plan, status, stripe_customer_id, stripe_subscription_id, included_credits
       FROM entitlements WHERE organization_id = $1`,
    [ORG],
  );
  return res.rows as {
    plan: string;
    status: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
    included_credits: number;
  }[];
};

const balance = async (): Promise<number | null> => {
  const res = await scratch.pool.query(
    `SELECT balance FROM run_credit_accounts WHERE organization_id = $1`,
    [ORG],
  );
  const row = res.rows[0] as { balance: number } | undefined;
  return row ? row.balance : null;
};

const countWhere = async (
  table: string,
  where: string,
  params: string[],
): Promise<number> => {
  const res = await scratch.pool.query(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
    params,
  );
  return (res.rows[0] as { n: number }).n;
};

const deliver = async (payload: string, signature?: string) =>
  handleStripeWebhook(
    deps(),
    payload,
    signature ?? signPayload(payload, SIGNING_KEY),
  );

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  db = createDb(scratch.pool);
  const now = new Date().toISOString();
  await scratch.pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'Webhook', 'webhook@example.com', true, $2, $2)`,
    [USER_ID, now],
  );
  await scratch.pool.query(
    `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Org W', 'org-w', $2)`,
    [ORG, now],
  );
}, 60_000);

afterAll(async () => {
  await scratch?.destroy();
});

describe("webhook signature verification (table-driven negatives)", () => {
  const negatives: {
    name: string;
    build: () => { payload: string; signature: string };
  }[] = [
    {
      name: "tampered payload",
      build: () => {
        const payload = checkoutPayload({ eventId: "evt_bad_tamper" });
        return {
          payload: `${payload} `,
          signature: signPayload(payload, SIGNING_KEY),
        };
      },
    },
    {
      name: "wrong signing key",
      build: () => {
        const payload = checkoutPayload({ eventId: "evt_bad_key" });
        return {
          payload,
          signature: signPayload(payload, "whsec_wrong_key_000000"),
        };
      },
    },
    {
      name: "missing signature header",
      build: () => ({
        payload: checkoutPayload({ eventId: "evt_bad_missing" }),
        signature: "",
      }),
    },
    {
      name: "timestamp outside the tolerance window",
      build: () => {
        const payload = checkoutPayload({ eventId: "evt_bad_stale" });
        return { payload, signature: signPayload(payload, SIGNING_KEY, -4000) };
      },
    },
  ];

  for (const negative of negatives) {
    it(`rejects ${negative.name}`, async () => {
      const { payload, signature } = negative.build();
      await expect(deliver(payload, signature)).rejects.toThrow();
    });
  }

  it("leaves no trace of rejected deliveries", async () => {
    expect(await countWhere("webhook_events", "true", [])).toBe(0);
    expect(await entitlementRows()).toHaveLength(0);
    expect(await balance()).toBeNull();
  });
});

describe("checkout → entitlement activation", () => {
  it("activates the entitlement and grants the included credits", async () => {
    const payload = checkoutPayload({ eventId: "evt_checkout_1" });
    const result = await deliver(payload);

    expect(result.outcome).toBe("processed");
    expect(result.effects).toEqual(
      expect.arrayContaining(["entitlement_activated", "credits_granted"]),
    );

    const rows = await entitlementRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      plan: "pro_monthly",
      status: "active",
      stripe_customer_id: "cus_test_1",
      stripe_subscription_id: "sub_test_1",
      included_credits: 100,
    });

    expect(await balance()).toBe(100);
    expect(
      await countWhere("run_credit_entries", "organization_id = $1", [ORG]),
    ).toBe(1);
    expect(
      await countWhere("webhook_events", "id = $1", ["evt_checkout_1"]),
    ).toBe(1);
  });

  it("replaying the same event id applies no second effect", async () => {
    const payload = checkoutPayload({ eventId: "evt_checkout_1" });
    const result = await deliver(payload);

    expect(result.outcome).toBe("duplicate");
    expect(result.effects).toEqual([]);
    expect(await balance()).toBe(100);
    expect(
      await countWhere("run_credit_entries", "organization_id = $1", [ORG]),
    ).toBe(1);
    expect(await countWhere("webhook_events", "true", [])).toBe(1);
  });
});

describe("cancellation paths drop the entitlement", () => {
  it("drops the entitlement when the subscription is deleted", async () => {
    const payload = JSON.stringify({
      id: "evt_sub_deleted",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_test_1" } },
    });
    const result = await deliver(payload);

    expect(result.outcome).toBe("processed");
    expect(result.effects).toContain("entitlement_dropped");

    const rows = await entitlementRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("canceled");
  });

  it("drops the entitlement on refund too (re-activating first)", async () => {
    const reactivate = checkoutPayload({
      eventId: "evt_checkout_2",
      subscriptionId: "sub_test_2",
    });
    const first = await deliver(reactivate);
    expect(first.outcome).toBe("processed");
    expect(await balance()).toBe(200);

    const refund = JSON.stringify({
      id: "evt_refund",
      type: "charge.refunded",
      data: { object: { id: "in_test_1", metadata: { organizationId: ORG } } },
    });
    const result = await deliver(refund);

    expect(result.outcome).toBe("processed");
    expect(result.effects).toContain("entitlement_dropped");
    const rows = await entitlementRows();
    expect(rows[0]?.status).toBe("canceled");
    // Credits are not clawed back by a refund event — the spec only
    // drops entitlement; balance stays put.
    expect(await balance()).toBe(200);
  });

  it("records unknown event types without acting on them", async () => {
    const payload = JSON.stringify({
      id: "evt_unknown",
      type: "customer.created",
      data: { object: { id: "cus_x" } },
    });
    const result = await deliver(payload);

    expect(result.outcome).toBe("ignored");
    expect(result.effects).toEqual([]);
    expect(await countWhere("webhook_events", "id = $1", ["evt_unknown"])).toBe(
      1,
    );

    const replay = await deliver(payload);
    expect(replay.outcome).toBe("duplicate");
  });

  it("ignores checkouts without organization metadata, but records them", async () => {
    const payload = checkoutPayload({
      eventId: "evt_no_org",
      includeOrganization: false,
    });
    const result = await deliver(payload);

    expect(result.outcome).toBe("ignored");
    expect(await countWhere("webhook_events", "id = $1", ["evt_no_org"])).toBe(
      1,
    );
    expect(await balance()).toBe(200);
    const rows = await entitlementRows();
    expect(rows[0]?.plan).toBe("pro_monthly");
    expect(rows[0]?.status).toBe("canceled");
  });

  it("ignores checkouts for price ids missing from config", async () => {
    const payload = checkoutPayload({
      eventId: "evt_unknown_price",
      priceId: "price_not_in_config",
    });
    const result = await deliver(payload);

    expect(result.outcome).toBe("ignored");
    expect(await balance()).toBe(200);
    expect(
      await countWhere("webhook_events", "id = $1", ["evt_unknown_price"]),
    ).toBe(1);
  });

  it("ignores a subscription deletion that matches no entitlement", async () => {
    const payload = JSON.stringify({
      id: "evt_sub_unknown",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_never_seen" } },
    });
    const result = await deliver(payload);

    expect(result.outcome).toBe("ignored");
    expect(result.effects).toEqual([]);
    expect(
      await countWhere("webhook_events", "id = $1", ["evt_sub_unknown"]),
    ).toBe(1);
  });

  it("ignores a subscription deletion with a malformed payload", async () => {
    const payload = JSON.stringify({
      id: "evt_sub_malformed",
      type: "customer.subscription.deleted",
      data: { object: { notAnId: true } },
    });
    const result = await deliver(payload);

    expect(result.outcome).toBe("ignored");
    expect(result.effects).toEqual([]);
  });

  it("ignores a refund for an organization without an entitlement", async () => {
    const payload = JSON.stringify({
      id: "evt_refund_orphan",
      type: "invoice.payment_refunded",
      data: {
        object: { id: "in_orphan", metadata: { organizationId: "org_nobody" } },
      },
    });
    const result = await deliver(payload);

    expect(result.outcome).toBe("ignored");
    expect(result.effects).toEqual([]);
    expect(await balance()).toBe(200);
  });

  it("ignores a refund whose payload lacks organization metadata", async () => {
    const payload = JSON.stringify({
      id: "evt_refund_malformed",
      type: "charge.refunded",
      data: { object: { id: "in_no_meta" } },
    });
    const result = await deliver(payload);

    expect(result.outcome).toBe("ignored");
    expect(result.effects).toEqual([]);
  });
});
