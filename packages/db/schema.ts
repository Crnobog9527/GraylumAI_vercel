import { sql } from 'drizzle-orm';
import { pgTable, text, uuid, integer, timestamp, jsonb, primaryKey, decimal, uniqueIndex, boolean } from 'drizzle-orm/pg-core';

// --- 核心表 ---

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(), // Corresponds to supabase.auth.users.id
  email: text('email'), // User email from auth.users
  nickname: text('nickname'),
  avatarUrl: text('avatar_url'),
  role: text('role', { enum: ['user', 'admin'] }).default('user').notNull(), // User role for access control
  status: text('status', { enum: ['active', 'disabled', 'banned'] }).default('active').notNull(), // Account status
  membershipLevel: text('membership_level', { enum: ['free', 'pro', 'gold'] }).default('free').notNull(), // Membership level
  credits: integer('credits').default(0).notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  lastIp: text('last_ip'),
  isDeleted: text('is_deleted').default('false').notNull(), // Soft delete flag
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  title: text('title').notNull(),
  modelId: uuid('model_id').references(() => aiModels.id),
  summary: text('summary'), // Conversation summary for context compression
  summaryTokens: integer('summary_tokens'), // Token count of summary
  summaryUpdatedAt: timestamp('summary_updated_at', { withTimezone: true }),
  summaryMetadata: jsonb('summary_metadata'), // Recursive summary layers metadata
  isDeleted: text('is_deleted').default('false').notNull(), // Soft delete flag
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  isDeleted: text('is_deleted').default('false').notNull(), // Soft delete flag
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const creditTransactions = pgTable('credit_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'set null' }),
  amount: integer('amount').notNull(),
  type: text('type', { enum: ['deduction', 'addition', 'purchase', 'refund'] }).notNull(),
  ledgerType: text('ledger_type', { enum: ['grant', 'spend', 'refund_clawback', 'adjustment', 'expiration'] }),
  reasonCode: text('reason_code'),
  countsAsSpend: boolean('counts_as_spend').default(false).notNull(),
  sourceType: text('source_type', { enum: ['stripe_invoice', 'stripe_checkout', 'stripe_refund', 'ai_task', 'admin', 'system'] }),
  sourceId: text('source_id'),
  sourceOrderId: uuid('source_order_id'),
  sourceRefundId: text('source_refund_id'),
  grantPeriodKey: text('grant_period_key'),
  description: text('description'),
  idempotencyKey: text('idempotency_key'),
  balanceBefore: integer('balance_before'),
  balanceAfter: integer('balance_after'),
  metadata: jsonb('metadata').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdempotencyKeyUnique: uniqueIndex('idx_credit_transactions_user_idempotency_key')
    .on(table.userId, table.idempotencyKey),
}));

// --- 配置表 ---

export const aiModels = pgTable('ai_models', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  modelId: text('model_id').notNull(),
  provider: text('provider', { enum: ['anthropic', 'openai', 'google', 'custom', 'builtin'] }).default('openai').notNull(),
  apiKey: text('api_key'),
  apiEndpoint: text('api_endpoint'),
  description: text('description'),
  maxTokens: integer('max_tokens').default(4096).notNull(),
  inputLimit: integer('input_limit').default(180000).notNull(),
  enableWebSearch: text('enable_web_search').default('false').notNull(),
  inputTokenCost: integer('input_token_cost').default(0).notNull(), // $/1M input tokens, stored as micro-dollars
  outputTokenCost: integer('output_token_cost').default(0).notNull(), // $/1M output tokens, stored as micro-dollars
  inputTokenCostAbove200k: integer('input_token_cost_above_200k').default(0).notNull(), // $/1M input tokens above 200K, stored as micro-dollars
  outputTokenCostAbove200k: integer('output_token_cost_above_200k').default(0).notNull(), // $/1M output tokens above 200K, stored as micro-dollars
  webSearchCost: integer('web_search_cost').default(0).notNull(), // $/1K searches, stored as micro-dollars
  tokenCountingSupported: text('token_counting_supported').default('false').notNull(),
  tokenCountingMethod: text('token_counting_method', {
    enum: ['anthropic_count_tokens', 'gemini_count_tokens', 'provider_usage', 'estimate', 'unsupported'],
  }).default('unsupported').notNull(),
  tokenizerFamily: text('tokenizer_family'),
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
  isDeleted: text('is_deleted').default('false').notNull(), // Soft delete flag
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
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
  isDeleted: text('is_deleted').default('false').notNull(), // Soft delete flag
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const creditPackages = pgTable('credit_packages', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  price: integer('price').notNull(), // In cents
  creditsAmount: integer('credits_amount').notNull(),
  bonusCredits: integer('bonus_credits').default(0).notNull(), // 赠送积分
  stripePriceId: text('stripe_price_id'),
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

export const scheduledJobRuns = pgTable('scheduled_job_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobKey: text('job_key').notNull(),
  triggerSource: text('trigger_source', { enum: ['manual', 'cron'] }).default('cron').notNull(),
  status: text('status', { enum: ['running', 'success', 'error'] }).default('running').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  summary: jsonb('summary').default({}).notNull(),
  error: text('error'),
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
  isDeleted: text('is_deleted').default('false').notNull(), // Soft delete flag
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
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
  isDeleted: text('is_deleted').default('false').notNull(), // Soft delete flag
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
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
}, (table) => ({
  inviteCodeInviteeIdUnique: uniqueIndex('idx_invitation_records_invite_code_invitee_id')
    .on(table.inviteCode, table.inviteeId),
}));

export const userCheckins = pgTable(
  'user_checkins',
  {
    userId: uuid('user_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
    checkinDate: text('checkin_date').notNull(), // YYYY-MM-DD (Asia/Shanghai)
    monthKey: text('month_key').notNull(), // YYYY-MM
    streakDay: integer('streak_day').notNull(),
    rewardCredits: integer('reward_credits').default(0).notNull(),
    monthlyBonusCredits: integer('monthly_bonus_credits').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.checkinDate] }),
  })
);

// --- 会员系统 ---

export const membershipPlans = pgTable('membership_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  level: text('level', { enum: ['free', 'pro', 'gold'] }).default('pro').notNull(),
  monthlyPrice: integer('monthly_price').default(990).notNull(), // In cents
  yearlyPrice: integer('yearly_price').default(9900).notNull(), // In cents
  stripeMonthlyPriceId: text('stripe_monthly_price_id'),
  stripeYearlyPriceId: text('stripe_yearly_price_id'),
  monthlyCredits: integer('monthly_credits').default(1500).notNull(),
  yearlyCredits: integer('yearly_credits').default(20000).notNull(),
  monthlyBonusCredits: integer('monthly_bonus_credits').default(0).notNull(),
  packageDiscount: integer('package_discount').default(100).notNull(), // 100 = no discount
  features: jsonb('features').default([]).notNull(), // Array of feature strings
  historyRetentionDays: integer('history_retention_days').default(30).notNull(), // 对话历史保存天数
  maxContextMessages: integer('max_context_messages').default(20).notNull(), // 最大上下文消息数
  allowExport: text('allow_export').default('false').notNull(), // 允许导出对话
  allowBatchExport: text('allow_batch_export').default('false').notNull(), // 允许批量导出
  isActive: text('is_active').default('true').notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// --- AI 对话计费表 ---

export const conversationContextSnapshots = pgTable('conversation_context_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  snapshotType: text('snapshot_type', {
    enum: ['rolling_summary', 'search_digest', 'compression_checkpoint'],
  }).notNull(),
  content: text('content').notNull(),
  sourceMessageStartId: uuid('source_message_start_id').references(() => messages.id, { onDelete: 'set null' }),
  sourceMessageEndId: uuid('source_message_end_id').references(() => messages.id, { onDelete: 'set null' }),
  sourceMessageCount: integer('source_message_count').default(0).notNull(),
  metadata: jsonb('metadata').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  conversationSnapshotTypeUnique: uniqueIndex('idx_context_snapshots_conversation_type')
    .on(table.conversationId, table.snapshotType),
}));

/**
 * Token 统计表 - 记录每次 AI 对话的 Token 使用情况
 * 用于精确计费、成本分析和使用追踪
 */
export const tokenStats = pgTable('token_stats', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  modelUsed: text('model_used').notNull(), // 实际使用的模型 ID (如 claude-sonnet-4-20250514)
  inputTokens: integer('input_tokens').notNull(), // 输入 Token 数
  outputTokens: integer('output_tokens').notNull(), // 输出 Token 数
  cachedTokens: integer('cached_tokens').default(0).notNull(), // 缓存命中的 Token 数
  cacheCreationTokens: integer('cache_creation_tokens').default(0).notNull(), // 缓存创建的 Token 数
  webSearchCount: integer('web_search_count').default(0).notNull(), // Web 搜索次数
  totalCostUsd: decimal('total_cost_usd', { precision: 12, scale: 6 }).notNull(), // 美元成本 (精确到微美元)
  totalCredits: integer('total_credits').notNull(), // 消耗的积分
  metadata: jsonb('metadata').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const paymentOrders = pgTable('payment_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'set null' }),
  itemType: text('item_type', { enum: ['credit_package', 'membership_plan'] }).notNull(),
  itemId: uuid('item_id').notNull(),
  billingCycle: text('billing_cycle', { enum: ['one_time', 'monthly', 'yearly'] }).default('one_time').notNull(),
  stripeCheckoutSessionId: text('stripe_checkout_session_id'),
  stripeInvoiceId: text('stripe_invoice_id'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  stripePriceId: text('stripe_price_id'),
  amountTotal: integer('amount_total'),
  currency: text('currency').default('usd').notNull(),
  mode: text('mode', { enum: ['payment', 'subscription'] }).notNull(),
  status: text('status', {
    enum: [
      'pending',
      'completed',
      'failed',
      'canceled',
      'expired',
      'refunded',
      'partially_refunded',
      'cancelled',
      'partial_refunded',
    ],
  }).default('pending').notNull(),
  paymentStatus: text('payment_status'),
  metadata: jsonb('metadata').default({}).notNull(),
  fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const userSubscriptions = pgTable('user_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  membershipPlanId: uuid('membership_plan_id').references(() => membershipPlans.id, { onDelete: 'set null' }),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id').notNull(),
  stripePriceId: text('stripe_price_id'),
  billingCycle: text('billing_cycle', { enum: ['monthly', 'yearly'] }).default('monthly').notNull(),
  status: text('status').notNull(),
  cancelAtPeriodEnd: text('cancel_at_period_end').default('false').notNull(),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  // REFUND-1B: credit-release termination (first successful refund event wins)
  creditReleaseTerminatedAt: timestamp('credit_release_terminated_at', { withTimezone: true }),
  creditReleaseTerminatedReason: text('credit_release_terminated_reason'),
  creditReleaseTerminatedEventId: text('credit_release_terminated_event_id'),
  creditReleaseTerminatedPeriodKey: text('credit_release_terminated_period_key'),
  metadata: jsonb('metadata').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const subscriptionCreditGrants = pgTable('subscription_credit_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  membershipPlanId: uuid('membership_plan_id').references(() => membershipPlans.id, { onDelete: 'set null' }),
  stripeSubscriptionId: text('stripe_subscription_id').notNull(),
  stripeInvoiceId: text('stripe_invoice_id'),
  billingCycle: text('billing_cycle', { enum: ['monthly', 'yearly'] }).notNull(),
  grantType: text('grant_type', {
    enum: ['monthly_invoice', 'annual_monthly_release', 'upgrade', 'manual', 'reversal'],
  }).notNull(),
  grantPeriodKey: text('grant_period_key').notNull(),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  periodIndex: integer('period_index'),
  totalPeriods: integer('total_periods'),
  creditsGranted: integer('credits_granted').notNull(),
  // REFUND-1B: per-period consumed quota, invariant 0 <= consumedAmount <= creditsGranted
  consumedAmount: integer('consumed_amount').default(0).notNull(),
  status: text('status', { enum: ['granted', 'skipped', 'reversed', 'failed'] }).default('granted').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  creditTransactionId: uuid('credit_transaction_id').references(() => creditTransactions.id, { onDelete: 'set null' }),
  metadata: jsonb('metadata').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  idempotencyKeyUnique: uniqueIndex('subscription_credit_grants_idempotency_key_key')
    .on(table.idempotencyKey),
  subscriptionPeriodKeyUnique: uniqueIndex('subscription_credit_grants_subscription_period_key_key')
    .on(table.stripeSubscriptionId, table.grantPeriodKey),
}));

/**
 * 计费历史表 - 记录三段式计费的每一步操作
 * 预扣 (pre_deduct) → 结算 (settle) → 退费 (refund)
 */
export const billingHistory = pgTable('billing_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  transactionId: uuid('transaction_id').references(() => creditTransactions.id, { onDelete: 'set null' }),
  operationType: text('operation_type', { enum: ['pre_deduct', 'settle', 'refund', 'abort_settle'] }).notNull(),
  amount: integer('amount').notNull(), // 积分变动量 (预扣为负，退费为正)
  reason: text('reason'), // 操作原因描述
  metadata: jsonb('metadata'), // 额外元数据 (如 usage 信息、preDeductId 等)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // REFUND-1B (R7): 每个预扣至多一条终态记录 (settle/refund/abort_settle) 的确定性屏障
  terminalPreDeductUnique: uniqueIndex('billing_history_terminal_pre_deduct_unique')
    .on(sql`(${table.metadata} ->> 'preDeductId')`)
    .where(sql`${table.operationType} IN ('settle', 'refund', 'abort_settle') AND (${table.metadata} ->> 'preDeductId') IS NOT NULL`),
}));

/**
 * AI 使用日志表 - 详细记录每次 AI 调用
 * 用于调试、安全审计和异常检测
 */
export const aiUsageLogs = pgTable('ai_usage_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => profiles.id, { onDelete: 'set null' }),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  requestId: text('request_id'), // Claude API 返回的请求 ID
  modelId: text('model_id').notNull(), // 请求的模型 ID
  status: text('status', { enum: ['success', 'failed', 'timeout', 'rate_limited', 'moderation_blocked'] }).notNull(),
  errorMessage: text('error_message'), // 失败时的错误信息
  inputLength: integer('input_length'), // 输入字符长度 (估算)
  latencyMs: integer('latency_ms'), // 请求延迟 (毫秒)
  ipAddress: text('ip_address'), // 客户端 IP
  userAgent: text('user_agent'), // 客户端 User-Agent
  metadata: jsonb('metadata'), // 其他调试信息
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// --- 功能模块表 ---

/**
 * 功能模块表 - 在功能广场中展示的 AI 功能模块
 * 每个模块包含预设的提示词，用户选择后可直接使用
 */
export const modules = pgTable('modules', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(), // 模块标题
  description: text('description'), // 简短描述
  fullDescription: text('full_description'), // 详细介绍
  icon: text('icon').default('Sparkles'), // Lucide 图标名称
  category: text('category', {
    enum: ['writing', 'marketing', 'video', 'business', 'education', 'coding', 'analysis', 'creative', 'other']
  }).default('other').notNull(), // 分类
  platform: text('platform').default('all'), // 适用平台

  // 核心提示词字段 (与 prompts 表对应)
  modelId: uuid('model_id').references(() => aiModels.id, { onDelete: 'set null' }), // 指定模型
  promptContent: text('prompt_content'), // 提示词内容
  systemPrompt: text('system_prompt'), // 系统提示词
  userPromptTemplate: text('user_prompt_template'), // 用户提示词模板

  // 模块特性字段
  features: text('features'), // 模块特点列表 (JSON string array)
  examples: text('examples'), // 使用示例列表 (JSON string array)
  preparationQuestions: text('preparation_questions'), // 用户准备问题列表 (JSON string array)

  // 统计与状态
  usageCount: integer('usage_count').default(0).notNull(), // 使用次数
  creditsMultiplier: decimal('credits_multiplier', { precision: 4, scale: 2 }).default('1.00'), // 积分倍率
  sortOrder: integer('sort_order').default(0).notNull(), // 排序权重
  isFeatured: boolean('is_featured').default(false).notNull(), // 是否精选
  active: boolean('active').default(true).notNull(), // 是否启用

  // 公开展示字段
  imageUrl: text('image_url'), // 精选模块展示图
  badgeType: text('badge_type'), // 展示徽标类型
  badgeText: text('badge_text'), // 展示徽标文本
  creditsDisplay: text('credits_display'), // 前端展示的积分说明
  linkUrl: text('link_url'), // 展示卡片跳转链接
  linkModuleId: uuid('link_module_id'), // 展示卡片关联模块

  // 元数据
  createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
