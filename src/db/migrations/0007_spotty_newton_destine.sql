CREATE TABLE "ledger_counterparties" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"alias" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"tombstoned_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"counterparty_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"entry_date" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"tombstoned_at" timestamp,
	CONSTRAINT "ledger_entries_amount_nonzero" CHECK (amount_cents <> 0)
);
--> statement-breakpoint
ALTER TABLE "ledger_counterparties" ADD CONSTRAINT "ledger_counterparties_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_counterparty_id_ledger_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."ledger_counterparties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_counterparties_org_idx" ON "ledger_counterparties" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_idem_idx" ON "ledger_entries" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ledger_entries_counterparty_idx" ON "ledger_entries" USING btree ("organization_id","counterparty_id");