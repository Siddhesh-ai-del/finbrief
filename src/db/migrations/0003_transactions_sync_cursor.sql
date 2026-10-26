CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"plaid_item_id" text NOT NULL,
	"plaid_transaction_id" text NOT NULL,
	"date" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"iso_currency_code" text,
	"name" text NOT NULL,
	"merchant_name" text,
	"personal_finance_category_primary" text,
	"personal_finance_category_detailed" text,
	"pending" boolean DEFAULT false NOT NULL,
	"pending_transaction_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plaid_items" ADD COLUMN "sync_cursor" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_plaid_item_id_plaid_items_id_fk" FOREIGN KEY ("plaid_item_id") REFERENCES "public"."plaid_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_org_date_idx" ON "transactions" USING btree ("organization_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_item_txn_idx" ON "transactions" USING btree ("plaid_item_id","plaid_transaction_id");