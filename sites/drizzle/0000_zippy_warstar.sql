CREATE TABLE `game_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_game_objects_expiry` ON `game_objects` (`expires_at`);