/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PublishedSkillSnapshot {
  readonly skillId: string;
  readonly skillKey: string;
  readonly publishedContent: string;
  readonly publishedVersion: number;
  readonly publishedContentHash: string;
  readonly moduleId: string;
}

export class ModuleSkillUnavailableError extends Error {
  readonly code = 'MODULE_SKILL_UNAVAILABLE';
  readonly statusCode = 503;

  constructor() {
    super('功能模块 Skill 暂不可用，请稍后重试或联系管理员');
    this.name = 'ModuleSkillUnavailableError';
  }
}

/** Resolve once per request. Never read drafts or cache/reload a running snapshot. */
export async function resolvePublishedSkillSnapshot(
  supabase: SupabaseClient,
  module: { id: string; skill_id: unknown },
): Promise<PublishedSkillSnapshot> {
  try {
    if (typeof module.skill_id !== 'string' || !module.skill_id.trim()) {
      throw new ModuleSkillUnavailableError();
    }
    const { data, error } = await supabase.from('skills')
      .select('id, skill_key, status, published_content, published_version, published_content_hash')
      .eq('id', module.skill_id)
      .single();
    if (error || !data || data.id !== module.skill_id || data.status !== 'published'
      || typeof data.skill_key !== 'string' || !data.skill_key.trim()
      || typeof data.published_content !== 'string' || !data.published_content.trim()
      || !Number.isSafeInteger(data.published_version) || data.published_version < 1
      || typeof data.published_content_hash !== 'string'
      || !/^[0-9a-f]{64}$/.test(data.published_content_hash)
      || createHash('sha256').update(data.published_content, 'utf8').digest('hex') !== data.published_content_hash) {
      throw new ModuleSkillUnavailableError();
    }
    return Object.freeze({
      skillId: data.id,
      skillKey: data.skill_key,
      publishedContent: data.published_content,
      publishedVersion: data.published_version,
      publishedContentHash: data.published_content_hash,
      moduleId: module.id,
    });
  } catch {
    // Do not disclose database errors, unpublished content, or private audit data.
    throw new ModuleSkillUnavailableError();
  }
}

export function skillSnapshotMetadata(snapshot: PublishedSkillSnapshot | undefined) {
  if (!snapshot) return {};
  return {
    skillId: snapshot.skillId,
    skillKey: snapshot.skillKey,
    publishedVersion: snapshot.publishedVersion,
    publishedContentHash: snapshot.publishedContentHash,
    moduleId: snapshot.moduleId,
  };
}
