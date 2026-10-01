import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const objects = sqliteTable('game_objects', {
  id: text('id').primaryKey(),
  revision: integer('revision').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, table => [index('idx_game_objects_expiry').on(table.expiresAt)]);
