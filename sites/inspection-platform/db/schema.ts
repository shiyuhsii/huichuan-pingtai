import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const inspections = sqliteTable('inspections', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  imageKey: text('image_key').notNull(),
  mime: text('mime').notNull(),
  revision: integer('revision').notNull().default(1),
  payload: text('payload').notNull(),
}, table => [index('inspections_owner_created').on(table.ownerId, table.createdAt)]);
