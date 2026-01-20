import { pgTable, text, uuid, integer, timestamp, jsonb, primaryKey } from 'drizzle-orm/pg-core';

// --- 核心表 ---

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(), // Corresponds to supabase.auth.users.id
  email: text('email'), // User email from auth.users
  nickname: text('nickname'),
  avatarUrl: text('avatar_url'),
  role: text('role', { enum: ['user', 'admin'] }).default('user').notNull(), // User role for access control
  status: text('status', { enum: ['active', 'disabled', 'banned'] }).default('active').notNull(), // Account status
  membershipLevel: text('membership_level', { enum: ['free', 'pro', 'gold'] }).default('free').notNull(), // Membership level
  credits: integer('credits').default(100).notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  lastIp: text('last_ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  title: text('title').notNull(),
  modelId: uuid('model_id').references(() => aiModels.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const creditTransactions = pgTable('credit_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'set null' }),
  amount: integer('amount').notNull(),
  type: text('type', { enum: ['deduction', 'addition', 'purchase', 'refund'] }).notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// --- 配置表 ---

export const aiModels = pgTable('ai_models', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  modelId: text('model_id').notNull(),
  provider: text('provider', { enum: ['anthropic', 'openai', 'google', 'custom', 'builtin'] }).default('anthropic').notNull(),
  apiKey: text('api_key'),
  apiEndpoint: text('api_endpoint'),
  description: text('description'),
  maxTokens: integer('max_tokens').default(4096).notNull(),
  inputLimit: integer('input_limit').default(180000).notNull(),
  enableWebSearch: text('enable_web_search').default('false').notNull(),
  inputTokenCost: integer('input_token_cost').default(0).notNull(), // Per 1M tokens, in micro-dollars
  outputTokenCost: integer('output_token_cost').default(0).notNull(),
  inputTokenCostAbove200k: integer('input_token_cost_above_200k').default(0).notNull(),
  outputTokenCostAbove200k: integer('output_token_cost_above_200k').default(0).notNull(),
  webSearchCost: integer('web_search_cost').default(0).notNull(), // Per 1K searches
  isActive: text('is_active').default('true').notNull(),
  config: jsonb('config'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value'),
});

// --- 业务表 ---

export const tickets = pgTable('tickets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description'), // 工单详细描述
  category: text('category', { enum: ['bug', 'feature', 'question', 'account', 'billing', 'other'] }).default('other').notNull(), // 工单分类
  priority: text('priority', { enum: ['low', 'medium', 'high', 'urgent'] }).default('medium').notNull(), // 优先级
  attachments: jsonb('attachments').default([]), // 附件URL列表
  status: text('status', { enum: ['open', 'closed', 'in_progress'] }).default('open').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const ticketReplies = pgTable('ticket_replies', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'set null' }), // User who replied
  content: text('content').notNull(),
  isAdmin: text('is_admin').default('false').notNull(), // 是否管理员回复
  attachments: jsonb('attachments').default([]), // 回复附件
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const creditPackages = pgTable('credit_packages', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  price: integer('price').notNull(), // In cents
  creditsAmount: integer('credits_amount').notNull(),
  bonusCredits: integer('bonus_credits').default(0).notNull(), // 赠送积分
  sortOrder: integer('sort_order').default(0).notNull(), // 排序顺序
  isPopular: text('is_popular').default('false').notNull(), // 热门标识
  active: text('active').default('true').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const invitations = pgTable('invitations', {
  code: text('code').primaryKey(),
  createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  usedBy: uuid('used_by').references(() => profiles.id, { onDelete: 'set null' }),
  status: text('status', { enum: ['active', 'used', 'expired'] }).default('active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const userActivityLogs = pgTable('user_activity_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'set null' }),
  adminId: uuid('admin_id').references(() => profiles.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  actionType: text('action_type', { enum: ['status_change', 'role_change', 'membership_change', 'credit_adjustment', 'system'] }).default('system').notNull(),
  details: jsonb('details').default({}),
  ipAddress: text('ip_address'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const announcements = pgTable('announcements', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  type: text('type', { enum: ['info', 'warning', 'success', 'error', 'promo', 'announcement'] }).default('info').notNull(),
  announcementType: text('announcement_type', { enum: ['homepage', 'banner'] }).default('homepage').notNull(),
  bannerStyle: text('banner_style', { enum: ['info', 'warning', 'success', 'error', 'promo', 'announcement'] }).default('info'),
  bannerLink: text('banner_link'),
  icon: text('icon').default('Megaphone'),
  iconColor: text('icon_color').default('text-blue-500'),
  tag: text('tag'),
  tagColor: text('tag_color').default('blue'),
  priority: integer('priority').default(0).notNull(),
  active: text('active').default('true').notNull(),
  startDate: timestamp('start_date', { withTimezone: true }).defaultNow(),
  endDate: timestamp('end_date', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const prompts = pgTable('prompts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  content: text('content').notNull(),
  // 新增字段
  systemPrompt: text('system_prompt'),
  userPromptTemplate: text('user_prompt_template'),
  modelId: uuid('model_id').references(() => aiModels.id, { onDelete: 'set null' }),
  platform: text('platform', { enum: ['all', 'web', 'mobile', 'desktop', 'api'] }).default('all'),
  features: text('features'), // JSON string array
  userQuestions: text('user_questions'), // JSON string array
  icon: text('icon').default('Wand2'),
  // 原有字段
  category: text('category', { enum: ['general', 'assistant', 'creative', 'coding', 'translation', 'analysis'] }).default('general').notNull(),
  isSystem: text('is_system').default('false').notNull(),
  active: text('active').default('true').notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// --- 邀请记录 ---

export const invitationRecords = pgTable('invitation_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  inviteCode: text('invite_code').notNull(),
  inviterId: uuid('inviter_id').references(() => profiles.id, { onDelete: 'set null' }),
  inviterEmail: text('inviter_email'),
  inviteeId: uuid('invitee_id').references(() => profiles.id, { onDelete: 'set null' }),
  inviteeEmail: text('invitee_email'),
  status: text('status', { enum: ['pending', 'registered', 'rewarded', 'rejected'] }).default('pending').notNull(),
  riskLevel: text('risk_level', { enum: ['low', 'medium', 'high'] }).default('low').notNull(),
  blockReason: text('block_reason'),
  inviterReward: integer('inviter_reward').default(0).notNull(),
  inviteeReward: integer('invitee_reward').default(0).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  rewardedAt: timestamp('rewarded_at', { withTimezone: true }),
});

// --- 会员系统 ---

export const membershipPlans = pgTable('membership_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  level: text('level', { enum: ['free', 'pro', 'gold'] }).default('pro').notNull(),
  monthlyPrice: integer('monthly_price').default(990).notNull(), // In cents
  yearlyPrice: integer('yearly_price').default(9900).notNull(), // In cents
  monthlyCredits: integer('monthly_credits').default(1500).notNull(),
  yearlyCredits: integer('yearly_credits').default(20000).notNull(),
  monthlyBonusCredits: integer('monthly_bonus_credits').default(0).notNull(),
  packageDiscount: integer('package_discount').default(100).notNull(), // 100 = no discount
  features: jsonb('features').default([]).notNull(), // Array of feature strings
  historyRetentionDays: integer('history_retention_days').default(30).notNull(), // 对话历史保存天数
  allowExport: text('allow_export').default('false').notNull(), // 允许导出对话
  allowBatchExport: text('allow_batch_export').default('false').notNull(), // 允许批量导出
  isActive: text('is_active').default('true').notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
