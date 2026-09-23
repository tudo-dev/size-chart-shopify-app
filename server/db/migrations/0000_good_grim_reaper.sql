CREATE TABLE `app_setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shop` (
	`shop` text PRIMARY KEY NOT NULL,
	`access_token` text NOT NULL,
	`scope` text,
	`expires_at` text,
	`refresh_token` text,
	`refresh_token_expires_at` text,
	`installed_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`uninstalled_at` text
);
--> statement-breakpoint
CREATE INDEX `shop_uninstalled_idx` ON `shop` (`uninstalled_at`);