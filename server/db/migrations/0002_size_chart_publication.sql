CREATE TABLE `size_chart_publication` (
	`shopify_product_id` text PRIMARY KEY NOT NULL,
	`chart_id` integer NOT NULL,
	`source_product_id` text NOT NULL,
	`chart_sha256` text NOT NULL,
	`handle` text,
	`title` text,
	`online_store_url` text,
	`template_suffix` text,
	`published_at` text NOT NULL,
	`checked_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_publication_chart` ON `size_chart_publication` (`chart_id`);--> statement-breakpoint
ALTER TABLE `size_chart` ADD `withdraw_requested_at` text;