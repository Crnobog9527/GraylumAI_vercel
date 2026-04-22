import type { SupabaseClient } from '@supabase/supabase-js';

type MinimalSupabaseClient = Pick<SupabaseClient, 'from'>;

export interface ConversationCleanupLevelStat {
  level: string;
  retentionDays: number;
  expiredCount: number;
  deletedCount: number;
}

export interface ConversationCleanupResult {
  deletedCount: number;
  stats: ConversationCleanupLevelStat[];
}

type CleanupProfileRow = {
  id: string;
  membership_level: string | null;
};

const DEFAULT_RETENTION_DAYS: Record<string, number> = {
  free: 7,
  pro: 30,
  gold: 90,
};

const CONVERSATION_CLEANUP_ERRORS = {
  loadRetentionSettings: 'Failed to load membership retention settings',
  calculateStats: 'Failed to calculate cleanup stats',
  loadProfiles: 'Failed to load profiles for cleanup',
  queryExpiredConversations: 'Failed to query expired conversations for cleanup',
  softDeleteMessages: 'Failed to soft-delete messages for cleanup',
  softDeleteConversations: 'Failed to soft-delete conversations for cleanup',
} as const;

async function buildRetentionMap(supabase: MinimalSupabaseClient) {
  const { data: plans, error } = await supabase
    .from('membership_plans')
    .select('level, history_retention_days');

  if (error) {
    throw new Error(CONVERSATION_CLEANUP_ERRORS.loadRetentionSettings);
  }

  const retentionMap = { ...DEFAULT_RETENTION_DAYS };
  for (const plan of plans ?? []) {
    if (plan.level && plan.history_retention_days) {
      retentionMap[plan.level] = plan.history_retention_days;
    }
  }

  return retentionMap;
}

export class ConversationCleanupService {
  constructor(
    private readonly options: {
      supabase: MinimalSupabaseClient;
      now?: Date;
    },
  ) {}

  async getCleanupStats() {
    const now = this.options.now ?? new Date();
    const retentionMap = await buildRetentionMap(this.options.supabase);
    const stats: ConversationCleanupLevelStat[] = [];

    for (const [level, retentionDays] of Object.entries(retentionMap)) {
      const cutoffDate = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
      const { count, error } = await this.options.supabase
        .from('conversations')
        .select('id, profiles!inner(membership_level)', { count: 'exact', head: true })
        .eq('profiles.membership_level', level)
        .eq('is_deleted', false)
        .lt('created_at', cutoffDate.toISOString());

      if (error) {
        throw new Error(`${CONVERSATION_CLEANUP_ERRORS.calculateStats} (${level})`);
      }

      stats.push({
        level,
        retentionDays,
        expiredCount: count ?? 0,
        deletedCount: 0,
      });
    }

    return {
      stats,
      totalExpired: stats.reduce((sum, item) => sum + item.expiredCount, 0),
    };
  }

  async run(): Promise<ConversationCleanupResult> {
    const now = this.options.now ?? new Date();
    const deletedAt = now.toISOString();
    const retentionMap = await buildRetentionMap(this.options.supabase);

    const { data: profiles, error: profilesError } = await this.options.supabase
      .from('profiles')
      .select('id, membership_level');

    if (profilesError) {
      throw new Error(CONVERSATION_CLEANUP_ERRORS.loadProfiles);
    }

    const statsByLevel = new Map<string, ConversationCleanupLevelStat>();
    for (const [level, retentionDays] of Object.entries(retentionMap)) {
      statsByLevel.set(level, {
        level,
        retentionDays,
        expiredCount: 0,
        deletedCount: 0,
      });
    }

    const profilesByLevel = new Map<string, string[]>();
    for (const profile of (profiles ?? []) as CleanupProfileRow[]) {
      const membershipLevel = profile.membership_level || 'free';
      const bucket = profilesByLevel.get(membershipLevel) ?? [];
      bucket.push(profile.id);
      profilesByLevel.set(membershipLevel, bucket);
    }

    let totalDeleted = 0;

    for (const [membershipLevel, profileIds] of Array.from(profilesByLevel.entries())) {
      const retentionDays = retentionMap[membershipLevel] ?? DEFAULT_RETENTION_DAYS.free;
      const cutoffDate = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
      const levelStat = statsByLevel.get(membershipLevel) ?? {
        level: membershipLevel,
        retentionDays,
        expiredCount: 0,
        deletedCount: 0,
      };

      const { data: expiredConversations, error: expiredError } = await this.options.supabase
        .from('conversations')
        .select('id')
        .in('user_id', profileIds)
        .eq('is_deleted', false)
        .lt('created_at', cutoffDate.toISOString());

      if (expiredError) {
        throw new Error(CONVERSATION_CLEANUP_ERRORS.queryExpiredConversations);
      }

      const conversationIds = (expiredConversations ?? []).map((conversation) => conversation.id);
      levelStat.expiredCount += conversationIds.length;

      if (conversationIds.length === 0) {
        statsByLevel.set(membershipLevel, levelStat);
        continue;
      }

      const { error: messageError } = await this.options.supabase
        .from('messages')
        .update({ is_deleted: true, deleted_at: deletedAt })
        .in('conversation_id', conversationIds)
        .eq('is_deleted', false);

      if (messageError) {
        throw new Error(CONVERSATION_CLEANUP_ERRORS.softDeleteMessages);
      }

      const { data: updatedConversations, error: conversationError } = await this.options.supabase
        .from('conversations')
        .update({ is_deleted: true, deleted_at: deletedAt })
        .in('id', conversationIds)
        .eq('is_deleted', false)
        .select('id');

      if (conversationError) {
        throw new Error(CONVERSATION_CLEANUP_ERRORS.softDeleteConversations);
      }

      const deletedCount = updatedConversations?.length ?? 0;
      levelStat.deletedCount += deletedCount;
      totalDeleted += deletedCount;
      statsByLevel.set(membershipLevel, levelStat);
    }

    return {
      deletedCount: totalDeleted,
      stats: Array.from(statsByLevel.values()),
    };
  }
}
