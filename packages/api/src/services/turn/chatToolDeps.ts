/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicalAccount, type CanonicalAccount } from '../research/tools/accountLinks';
import type { SocialPlatform } from '../research/vendors/types';
import { discoverSkillCatalog } from '../runtime/skillCatalog';
import { admitCatalogVoice } from '../runtime/voiceCatalog';
import { databaseSkillSource } from '../skills/databaseSource';
import type { ChatToolDeps } from './tools/chatTools';
import { FREE_RESULT_RESERVE_BYTES } from './tools/plan';
import { prepareSkills } from './tools/skills';

/*
 * CORE-PATH-V2 V2-6: what POST /api/turn gives a free chat for its tools. All of it runs before turn_open: the Skill catalog with
 * each entry's load result (cached by package hash), the catalog voice and the accounts social_account may look up. The list holds
 * the social Skills too: whether this account may see them is known at turn_open, and chat.ts drops them there.
 */
export function chatToolDeps(admin: SupabaseClient, user: () => SupabaseClient): ChatToolDeps {
  return {
    library: true,
    async skills(actorId) {
      const client = user();
      const catalog = await discoverSkillCatalog(client, admin, { maxResultBytes: FREE_RESULT_RESERVE_BYTES, excludeSocial: false, actorId });
      const prepared = await prepareSkills(catalog, entry => databaseSkillSource({ userClient: client, privateClient: admin,
        moduleId: entry.moduleId, skillId: entry.skillId, revisionId: entry.revisionId }), FREE_RESULT_RESERVE_BYTES);
      return { catalog, prepared };
    },
    async voice(actorId, catalog) {
      const voice = await admitCatalogVoice(admin, actorId, catalog);
      return voice && { text: voice.text, ...(voice.frozen.versionId ? { versionId: voice.frozen.versionId } : {}) };
    },
    async benchmarkAccounts(actorId, sessionId) {
      const { data, error } = await admin.rpc('research_chat_benchmark_accounts', { a: actorId, s: sessionId, e: null });
      if (error) throw new Error('TURN_BENCHMARK_ACCOUNTS_UNAVAILABLE');
      return (Array.isArray(data) ? data as Array<{ platform?: unknown; account?: unknown }> : []).flatMap(item => {
        if (typeof item?.platform !== 'string' || typeof item.account !== 'string') return [];
        const account = canonicalAccount(item.platform as SocialPlatform, item.account);
        return account ? [{ platform: item.platform as SocialPlatform, account } satisfies CanonicalAccount] : [];
      });
    },
  };
}
