/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type ContextSnapshotType = 'rolling_summary' | 'search_digest' | 'compression_checkpoint';

export async function upsertContextSnapshot(
  supabase: SupabaseClient,
  params: {
    conversationId: string;
    snapshotType: ContextSnapshotType;
    content: string;
    sourceMessageStartId?: string | null;
    sourceMessageEndId?: string | null;
    sourceMessageCount?: number;
    metadata?: Record<string, unknown>;
  },
) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('conversation_context_snapshots')
    .upsert({
      conversation_id: params.conversationId,
      snapshot_type: params.snapshotType,
      content: params.content,
      source_message_start_id: params.sourceMessageStartId ?? null,
      source_message_end_id: params.sourceMessageEndId ?? null,
      source_message_count: params.sourceMessageCount ?? 0,
      metadata: params.metadata ?? {},
      updated_at: now,
    }, {
      onConflict: 'conversation_id,snapshot_type',
    });

  if (error) {
    throw new Error(`Failed to upsert context snapshot: ${error.message}`);
  }
}
