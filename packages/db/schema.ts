import { pgTable, text, uuid, integer, timestamp } from 'drizzle-orm/pg-core';

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  nickname: text('nickname'),
  avatarUrl: text('avatar_url'),
  credits: integer('credits').default(100).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
