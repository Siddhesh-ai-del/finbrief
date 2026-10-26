ALTER TABLE "plaid_items" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "plaid_items" ADD COLUMN "stale_reason" text;--> statement-breakpoint
ALTER TABLE "plaid_items" ADD COLUMN "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL;