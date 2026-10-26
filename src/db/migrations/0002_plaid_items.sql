CREATE TABLE "plaid_items" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"item_id_ciphertext" text NOT NULL,
	"access_token_ciphertext" text NOT NULL,
	"item_id_index" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plaid_items" ADD CONSTRAINT "plaid_items_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plaid_items_org_idx" ON "plaid_items" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plaid_items_item_id_idx" ON "plaid_items" USING btree ("item_id_index");