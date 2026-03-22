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

const DEFAULT_RETENTION_DAYS: Record<string, number> = {
  free: 7,
  pro: 30,
  gold: 90,
};

async function buildRetentionMap(supabase: MinimalSupabaseClient) {
  const { data: plans, error } = await supabase
    .from('membership_plans')
    .select('level, history_retention_days');

  if (error) {
    throw new Error(`Failed to load membership retention settings: ${error.message}`);
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
        .eq('is_deleted', 'false')
        .lt('created_at', cutoffDate.toISOString());

      if (error) {
        throw new Error(`Failed to calculate cleanup stats for ${level}: ${error.message}`);
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
      throw new Error(`Failed to load profiles for cleanup: ${profilesError.message}`);
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

    let totalDeleted = 0;

    for (const profile of profiles ?? []) {
      const membershipLevel = profile.membership_level || 'free';
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
        .eq('user_id', profile.id)
        .eq('is_deleted', 'false')
        .lt('created_at', cutoffDate.toISOString());

      if (expiredError) {
        throw new Error(`Failed to query expired conversations for ${profile.id}: ${expiredError.message}`);
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
        .eq('is_deleted', 'false');

      if (messageError) {
        throw new Error(`Failed to soft-delete messages for ${profile.id}: ${messageError.message}`);
      }

      const { data: updatedConversations, error: conversationError } = await this.options.supabase
        .from('conversations')
        .update({ is_deleted: true, deleted_at: deletedAt })
        .in('id', conversationIds)
        .eq('user_id', profile.id)
        .eq('is_deleted', 'false')
        .select('id');

      if (conversationError) {
        throw new Error(`Failed to soft-delete conversations for ${profile.id}: ${conversationError.message}`);
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
