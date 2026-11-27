CREATE TABLE "customers" (
	"id" text PRIMARY KEY,
	"email" text,
	"name" text,
	"status" text,
	"paddle_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY,
	"customer_id" text NOT NULL,
	"status" text NOT NULL,
	"price_id" text,
	"product_id" text,
	"plan" text,
	"store_activation_id" text,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"scheduled_change_action" text,
	"scheduled_change_effective_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"last_transaction_id" text,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY,
	"event_type" text NOT NULL,
	"entity_id" text,
	"occurred_at" timestamp with time zone,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" text
);
--> statement-breakpoint
CREATE INDEX "subscriptions_customer_idx" ON "subscriptions" ("customer_id");--> statement-breakpoint
CREATE INDEX "subscriptions_store_idx" ON "subscriptions" ("store_activation_id");