ALTER TABLE "plaid_items" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plaid_items" ADD COLUMN "purge_after" timestamp with time zone;