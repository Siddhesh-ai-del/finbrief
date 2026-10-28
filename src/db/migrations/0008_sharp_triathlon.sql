CREATE TABLE "ledger_entry_links" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	"decided_by" text
);
--> statement-breakpoint
ALTER TABLE "ledger_entry_links" ADD CONSTRAINT "ledger_entry_links_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry_links" ADD CONSTRAINT "ledger_entry_links_entry_id_ledger_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry_links" ADD CONSTRAINT "ledger_entry_links_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entry_links_org_idx" ON "ledger_entry_links" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entry_links_entry_live_idx" ON "ledger_entry_links" USING btree ("entry_id") WHERE "ledger_entry_links"."status" <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entry_links_txn_live_idx" ON "ledger_entry_links" USING btree ("transaction_id") WHERE "ledger_entry_links"."status" <> 'rejected';