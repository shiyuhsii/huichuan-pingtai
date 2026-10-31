CREATE TABLE `inspections` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`image_key` text NOT NULL,
	`mime` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inspections_owner_created` ON `inspections` (`owner_id`,`created_at`);