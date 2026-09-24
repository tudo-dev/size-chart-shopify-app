CREATE TABLE `shopify_product_source` (
	`shopify_product_id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`title` text NOT NULL,
	`product_type` text,
	`status` text,
	`source_product_id` text NOT NULL,
	`source_url` text,
	`size_options` text,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_product_source_id` ON `shopify_product_source` (`source_product_id`);--> statement-breakpoint
CREATE TABLE `size_chart_job` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`note` text,
	`error` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `size_chart_upload` (
	`id` integer PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`file_sha256` text NOT NULL,
	`uploaded_by` text,
	`rows` integer NOT NULL,
	`added` integer NOT NULL,
	`changed` integer NOT NULL,
	`unchanged` integer NOT NULL,
	`no_image` integer NOT NULL,
	`skipped` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `size_chart` (
	`id` integer PRIMARY KEY NOT NULL,
	`source_product_id` text NOT NULL,
	`source_url` text,
	`product_type` text,
	`store` text,
	`remark` text,
	`image_url` text,
	`image_sha256` text,
	`image_path` text,
	`image_bytes` integer,
	`image_width` integer,
	`image_height` integer,
	`image_fetched_at` text,
	`status` text NOT NULL,
	`read_json` text,
	`chart_json` text,
	`flags` text,
	`notices` text,
	`confidence` real,
	`read_model` text,
	`read_at` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`review_note` text,
	`reviewed_by` text,
	`reviewed_at` text,
	`shopify_file_id` text,
	`shopify_image_url` text,
	`published_at` text,
	`published_sha256` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_size_chart_source` ON `size_chart` (`source_product_id`);--> statement-breakpoint
CREATE INDEX `idx_size_chart_status` ON `size_chart` (`status`);--> statement-breakpoint
CREATE INDEX `idx_size_chart_image` ON `size_chart` (`image_sha256`);