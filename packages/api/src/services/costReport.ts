import { z } from 'zod';

export const costMetricSchema = z.enum(['credits', 'usd']);
export type CostMetric = z.infer<typeof costMetricSchema>;

// ============================================
// 类型定义
// ============================================

export interface CostOverview {
  metric: CostMetric;
  todayCost: number;
  todayCalls: number;
  monthCost: number;
  monthCalls: number;
  avgCostPerCall: number;
  todayCredits: number;
  todayUsd: number;
  monthCredits: number;
  monthUsd: number;
}

export interface ModelDistribution {
  modelId: string;
  modelName: string;
  calls: number;
  cost: number;
  percentage: number;
  credits: number;
  usd: number;
}

export interface DailyCost {
  date: string;
  cost: number;
  calls: number;
  credits: number;
  usd: number;
}

export interface TopUser {
  userId: string;
  email: string;
  nickname: string;
  totalCost: number;
  totalCalls: number;
  totalCredits: number;
  totalUsd: number;
}

export interface UsageLog {
  id: string;
  requestId: string | null;
  userId: string;
  userEmail: string;
  modelId: string;
  status: string;
  inputLength: number;
  latencyMs: number;
  routingReason: string | null;
  promptName: string | null;
  createdAt: string;
}

export interface TokenStat {
  id: string;
  conversationId: string;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalCredits: number;
  createdAt: string;
}

export interface CacheEfficiencySummary {
  totalRequests: number;
  cacheHits: number | null;
  hitRate: number | null;
  savedCredits: number | null;
  savedUsd: number | null;
  savedValue: number | null;
}

export interface CostsDashboard {
  overview: CostOverview;
  trend: DailyCost[];
  distribution: ModelDistribution[];
  topUsers: TopUser[];
  cacheEfficiency: CacheEfficiencySummary;
}

export interface CostRow {
  total_credits: number | null;
  total_cost_usd: string | null;
  created_at: string;
}

export interface DashboardRow extends CostRow {
  model_used: string | null;
  user_id: string | null;
  cached_tokens: number | null;
  input_tokens: number | null;
}

export interface TopUserAggregateRow {
  user_id: string | null;
  total_credits: number | null;
  total_cost_usd: string | null;
}

export interface TopUserProfile {
  id: string;
  email: string | null;
  nickname: string | null;
}

function parseUsd(value: string | null | undefined): number {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) throw new Error('Invalid recorded USD cost');
  return amount;
}

function dateParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day'),
    hour: value('hour'), minute: value('minute'), second: value('second') };
}

function zonedStartIso(year: number, month: number, day: number, timezone: string): string {
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  for (let i = 0; i < 3; i++) {
    const local = dateParts(new Date(candidate), timezone);
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day,
      local.hour, local.minute, local.second);
    candidate += target - localAsUtc;
  }
  return new Date(candidate).toISOString();
}

export function getCostWindow(now: Date, days: number, timezone: string) {
  const local = dateParts(now, timezone);
  const firstDay = new Date(Date.UTC(local.year, local.month - 1, local.day - days + 1));
  const rangeStartIso = zonedStartIso(firstDay.getUTCFullYear(), firstDay.getUTCMonth() + 1,
    firstDay.getUTCDate(), timezone);
  return {
    rangeStartIso,
    todayStartIso: zonedStartIso(local.year, local.month, local.day, timezone),
    monthStartIso: zonedStartIso(local.year, local.month, 1, timezone),
  };
}

function zonedDateKey(date: Date, timezone: string): string {
  const { year, month, day } = dateParts(date, timezone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function buildCostOverviewFromRows(
  rows: CostRow[],
  todayStartIso: string,
  metric: CostMetric,
): CostOverview {
  let todayCredits = 0;
  let todayUsd = 0;
  let todayCalls = 0;
  let monthCredits = 0;
  let monthUsd = 0;

  for (const row of rows) {
    const credits = row.total_credits ?? 0;
    const usd = parseUsd(row.total_cost_usd);
    monthCredits += credits;
    monthUsd += usd;

    if (row.created_at >= todayStartIso) {
      todayCredits += credits;
      todayUsd += usd;
      todayCalls += 1;
    }
  }

  const monthCalls = rows.length;
  const todayCost = metric === 'usd' ? todayUsd : todayCredits;
  const monthCost = metric === 'usd' ? monthUsd : monthCredits;

  return {
    metric,
    todayCost,
    todayCalls,
    monthCost,
    monthCalls,
    avgCostPerCall: monthCalls > 0 ? monthCost / monthCalls : 0,
    todayCredits,
    todayUsd,
    monthCredits,
    monthUsd,
  };
}

export function buildTopUsersFromRows(
  rows: TopUserAggregateRow[],
  profiles: TopUserProfile[],
  metric: CostMetric,
  limit: number,
): TopUser[] {
  const aggregates = new Map<string, Omit<TopUser, 'email' | 'nickname' | 'userId'> & { email?: string; nickname?: string }>();

  for (const row of rows) {
    if (!row.user_id) {
      continue;
    }

    const existing = aggregates.get(row.user_id) ?? {
      totalCost: 0,
      totalCalls: 0,
      totalCredits: 0,
      totalUsd: 0,
    };
    const totalCredits = existing.totalCredits + (row.total_credits ?? 0);
    const totalUsd = existing.totalUsd + parseUsd(row.total_cost_usd);

    aggregates.set(row.user_id, {
      totalCalls: existing.totalCalls + 1,
      totalCredits,
      totalUsd,
      totalCost: metric === 'usd' ? totalUsd : totalCredits,
    });
  }

  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));

  return Array.from(aggregates.entries())
    .map(([userId, aggregate]) => ({
      userId,
      email: profileMap.get(userId)?.email ?? '',
      nickname: profileMap.get(userId)?.nickname ?? '',
      totalCost: aggregate.totalCost,
      totalCalls: aggregate.totalCalls,
      totalCredits: aggregate.totalCredits,
      totalUsd: aggregate.totalUsd,
    }))
    .sort((a, b) => b.totalCost - a.totalCost)
    .slice(0, limit);
}

export function buildCostTrendFromRows(
  rows: CostRow[],
  days: number,
  metric: CostMetric,
  now: Date,
  timezone = 'Asia/Shanghai',
): DailyCost[] {
  const dailyMap = new Map<string, { credits: number; usd: number; calls: number }>();

  for (let i = 0; i < days; i++) {
    const local = dateParts(now, timezone);
    const date = new Date(Date.UTC(local.year, local.month - 1, local.day - i));
    const dateStr = date.toISOString().split('T')[0];
    dailyMap.set(dateStr!, { credits: 0, usd: 0, calls: 0 });
  }

  for (const record of rows) {
    const dateStr = zonedDateKey(new Date(record.created_at), timezone);
    const existing = dailyMap.get(dateStr);
    if (!existing) continue;
    dailyMap.set(dateStr, {
      credits: existing.credits + (record.total_credits ?? 0),
      usd: existing.usd + parseUsd(record.total_cost_usd),
      calls: existing.calls + 1,
    });
  }

  return Array.from(dailyMap.entries())
    .map(([date, data]) => ({
      date,
      calls: data.calls,
      credits: data.credits,
      usd: data.usd,
      cost: metric === 'usd' ? data.usd : data.credits,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function buildModelDistributionFromRows(
  rows: Pick<DashboardRow, 'model_used' | 'total_credits' | 'total_cost_usd'>[],
  metric: CostMetric,
): ModelDistribution[] {
  const modelMap = new Map<string, { calls: number; credits: number; usd: number }>();
  let totalCost = 0;

  for (const record of rows) {
    const modelId = record.model_used ?? 'unknown';
    const existing = modelMap.get(modelId) ?? { calls: 0, credits: 0, usd: 0 };
    const credits = record.total_credits ?? 0;
    const usd = parseUsd(record.total_cost_usd);
    modelMap.set(modelId, {
      calls: existing.calls + 1,
      credits: existing.credits + credits,
      usd: existing.usd + usd,
    });
    totalCost += metric === 'usd' ? usd : credits;
  }

  return Array.from(modelMap.entries())
    .map(([modelId, data]) => ({
      modelId,
      modelName: getModelDisplayName(modelId),
      calls: data.calls,
      cost: metric === 'usd' ? data.usd : data.credits,
      credits: data.credits,
      usd: data.usd,
      percentage: totalCost > 0
        ? Math.round((((metric === 'usd' ? data.usd : data.credits) / totalCost) * 100))
        : 0,
    }))
    .sort((a, b) => b.cost - a.cost);
}

export function buildCacheEfficiencyFromRows(
  rows: Pick<DashboardRow, 'cached_tokens' | 'input_tokens' | 'total_credits' | 'total_cost_usd'>[],
  metric: CostMetric,
): CacheEfficiencySummary {
  const totalRequests = rows.length;
  let cacheHits = 0;
  let totalCachedTokens = 0;
  let totalInputTokens = 0;
  let totalCredits = 0;
  let totalUsd = 0;
  let unknownCacheUsage = false;
  let unknownSavings = false;

  for (const record of rows) {
    if (record.cached_tokens === null) unknownCacheUsage = true;
    if (record.cached_tokens === null || (record.cached_tokens > 0 && record.input_tokens === null)) {
      unknownSavings = true;
    }
    const cachedTokens = record.cached_tokens ?? 0;
    const inputTokens = record.input_tokens ?? 0;
    if (cachedTokens > 0) {
      cacheHits += 1;
    }
    totalCachedTokens += cachedTokens;
    totalInputTokens += inputTokens;
    totalCredits += record.total_credits ?? 0;
    totalUsd += parseUsd(record.total_cost_usd);
  }

  const savedCredits = unknownSavings ? null : totalInputTokens > 0
    ? (totalCachedTokens / totalInputTokens) * 0.9 * totalCredits
    : 0;
  const savedUsd = unknownSavings ? null : totalInputTokens > 0
    ? (totalCachedTokens / totalInputTokens) * 0.9 * totalUsd
    : 0;

  return {
    totalRequests,
    cacheHits: unknownCacheUsage ? null : cacheHits,
    hitRate: unknownCacheUsage ? null : totalRequests > 0 ? Math.round((cacheHits / totalRequests) * 100) : 0,
    savedCredits,
    savedUsd,
    savedValue: metric === 'usd' ? savedUsd : savedCredits,
  };
}

export function buildCostsDashboardFromRows(
  rows: DashboardRow[],
  profiles: TopUserProfile[],
  input: { metric: CostMetric; days: number; limit: number; now: Date; timezone?: string;
    rangeStartIso?: string; todayStartIso: string; monthStartIso: string },
): CostsDashboard {
  const rangeStartIso = input.rangeStartIso ?? getCostWindow(input.now, input.days,
    input.timezone ?? 'Asia/Shanghai').rangeStartIso;
  const rangeRows = rows.filter((row) => row.created_at >= rangeStartIso);
  const monthRows = rows.filter((row) => row.created_at >= input.monthStartIso);

  return {
    overview: buildCostOverviewFromRows(monthRows, input.todayStartIso, input.metric),
    trend: buildCostTrendFromRows(rangeRows, input.days, input.metric, input.now, input.timezone),
    distribution: buildModelDistributionFromRows(rangeRows, input.metric),
    topUsers: buildTopUsersFromRows(rangeRows, profiles, input.metric, input.limit),
    cacheEfficiency: buildCacheEfficiencyFromRows(rangeRows, input.metric),
  };
}

function getModelDisplayName(modelId: string): string {
  const modelNames: Record<string, string> = {
    'bill2.aggregate': 'BILL2 汇总（非单一模型）',
    'claude-3-5-haiku-20241022': 'Claude 3.5 Haiku',
    'claude-sonnet-4-20250514': 'Claude 4 Sonnet',
    'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
    'claude-3-opus-20240229': 'Claude 3 Opus',
  };
  return modelNames[modelId] ?? modelId;
}
