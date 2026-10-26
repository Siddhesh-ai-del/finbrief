/**
 * Stripe webhook state machine (plan Step 0.4).
 *
 * Exactly-once semantics: the Stripe event id is claimed with
 * `ON CONFLICT DO NOTHING` inside the same transaction that applies
 * the event's effects — a replayed delivery finds the row and becomes
 * a `duplicate` no-op, and a failure mid-effect rolls the claim back
 * so Stripe's retry can run it again.
 *
 * Signature verification happens before any database work: rejected
 * deliveries leave no trace. Payloads are zod-validated at the
 * boundary; an unparseable or incomplete payload is recorded and
 * ignored (never half-applied, never retried forever).
 *
 * Entitlement numbers come from the injected BillingConfig — no
 * price, fee or credit amount is hardcoded here (Stripe US rates are
 * UNVERIFIED per the research brief; this code runs in test mode).
 */
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { z } from "zod";
import { entitlements, webhookEvents } from "../db/schema/billing";
import type { Db } from "../db/tenancy";
import { grantIncluded } from "./run-credits";
import type { LedgerRunner } from "./run-credits";

export interface BillingConfig {
  /** Stripe price id → plan name + included run credits. */
  prices: Record<string, { plan: string; includedCredits: number }>;
}

export interface WebhookDeps {
  stripe: Stripe;
  db: Db;
  webhookSecret: string;
  config: BillingConfig;
}

type Effect =
  "entitlement_activated" | "credits_granted" | "entitlement_dropped";

export interface WebhookResult {
  outcome: "processed" | "ignored" | "duplicate";
  type: string;
  effects: Effect[];
}

const checkoutSessionSchema = z.object({
  metadata: z.object({
    organizationId: z.string().min(1),
    priceId: z.string().min(1),
  }),
  customer: z.string().min(1).nullish(),
  subscription: z.string().min(1).nullish(),
});

const subscriptionDeletedSchema = z.object({ id: z.string().min(1) });

const refundSchema = z.object({
  metadata: z.object({ organizationId: z.string().min(1) }),
});

async function activateCheckout(
  tx: LedgerRunner,
  raw: unknown,
  config: BillingConfig,
): Promise<Effect[]> {
  const parsed = checkoutSessionSchema.safeParse(raw);
  if (!parsed.success) return [];
  const plan = config.prices[parsed.data.metadata.priceId];
  if (!plan) return [];
  const { organizationId } = parsed.data.metadata;
  await tx
    .insert(entitlements)
    .values({
      organizationId,
      plan: plan.plan,
      status: "active",
      stripeCustomerId: parsed.data.customer ?? null,
      stripeSubscriptionId: parsed.data.subscription ?? null,
      includedCredits: plan.includedCredits,
    })
    .onConflictDoUpdate({
      target: entitlements.organizationId,
      set: {
        plan: plan.plan,
        status: "active",
        stripeCustomerId: parsed.data.customer ?? null,
        stripeSubscriptionId: parsed.data.subscription ?? null,
        includedCredits: plan.includedCredits,
        updatedAt: new Date(),
      },
    });
  await grantIncluded(tx, organizationId, plan.includedCredits);
  return ["entitlement_activated", "credits_granted"];
}

async function dropBySubscription(
  tx: LedgerRunner,
  raw: unknown,
): Promise<Effect[]> {
  const parsed = subscriptionDeletedSchema.safeParse(raw);
  if (!parsed.success) return [];
  const rows = await tx
    .update(entitlements)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(eq(entitlements.stripeSubscriptionId, parsed.data.id))
    .returning({ organizationId: entitlements.organizationId });
  return rows.length > 0 ? ["entitlement_dropped"] : [];
}

async function dropByOrganization(
  tx: LedgerRunner,
  raw: unknown,
): Promise<Effect[]> {
  const parsed = refundSchema.safeParse(raw);
  if (!parsed.success) return [];
  const rows = await tx
    .update(entitlements)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(eq(entitlements.organizationId, parsed.data.metadata.organizationId))
    .returning({ organizationId: entitlements.organizationId });
  return rows.length > 0 ? ["entitlement_dropped"] : [];
}

async function applyEffects(
  tx: LedgerRunner,
  event: Stripe.Event,
  config: BillingConfig,
): Promise<Effect[]> {
  const raw = event.data.object as unknown;
  switch (event.type) {
    case "checkout.session.completed":
      return activateCheckout(tx, raw, config);
    case "customer.subscription.deleted":
      return dropBySubscription(tx, raw);
    case "charge.refunded":
      return dropByOrganization(tx, raw);
    default:
      return [];
  }
}

/**
 * Verify `signature` over `rawBody`, then apply the event exactly
 * once. Throws on any signature problem before touching the database.
 */
export async function handleStripeWebhook(
  deps: WebhookDeps,
  rawBody: string,
  signature: string,
): Promise<WebhookResult> {
  const event = deps.stripe.webhooks.constructEvent(
    rawBody,
    signature,
    deps.webhookSecret,
  );
  let result: WebhookResult = {
    outcome: "ignored",
    type: event.type,
    effects: [],
  };
  await deps.db.transaction(async (tx) => {
    const claimed = await tx
      .insert(webhookEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing({ target: webhookEvents.id })
      .returning({ id: webhookEvents.id });
    if (claimed.length === 0) {
      result = { outcome: "duplicate", type: event.type, effects: [] };
      return;
    }
    const effects = await applyEffects(tx, event, deps.config);
    result = {
      outcome: effects.length > 0 ? "processed" : "ignored",
      type: event.type,
      effects,
    };
  });
  return result;
}
