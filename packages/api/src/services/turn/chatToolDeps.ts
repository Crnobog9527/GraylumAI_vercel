/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicalAccount, type CanonicalAccount } from '../research/tools/accountLinks';
import type { SocialPlatform } from '../research/vendors/types';
import { discoverSkillCatalog, entryContentSource, moduleUsesVoice, pinnedCatalogEntry } from '../runtime/skillCatalog';
import { admitCatalogVoice } from '../runtime/voiceCatalog';
import { swallow } from '../../lib/swallow';
import { readOwnDataTier } from '../membershipEntitlements';
import { REVIEW_SWITCH } from '../publishMonitor/reviewSettings';
import { rowFor } from '../runtime/settingsRows';
import { admitOwnPosts } from '../runtime/workspacePosts';
import { databaseSkillSource } from '../skills/databaseSource';
import type { ChatToolDeps } from './tools/chatTools';
import { FREE_RESULT_RESERVE_BYTES } from './tools/plan';
import { prepareSkills, withPinnedSkill } from './tools/skills';

/*
 * CORE-PATH-V2 V2-6: what POST /api/turn gives a free chat for its tools. All of it runs before turn_open: the Skill catalog with
 * each entry's load result (cached by package hash), the catalog voice and the accounts social_account may look up. The list holds
 * the social Skills too: whether this account may see them is known at turn_open, and chat.ts drops them there.
 */
export function chatToolDeps(admin: SupabaseClient, user: () => SupabaseClient): ChatToolDeps {
  return {
    library: true,
    async skills(actorId, pin) {
      const client = user();
      const sourceOf = (entry: { moduleId: string; skillId: string; revisionId: string }) => databaseSkillSource({ userClient: client,
        privateClient: admin, moduleId: entry.moduleId, skillId: entry.skillId, revisionId: entry.revisionId });
      const listed = await discoverSkillCatalog(client, admin, { maxResultBytes: FREE_RESULT_RESERVE_BYTES, excludeSocial: false, actorId });
      // A work item's method is the revision it is bound to, in place of what the catalog lists for its module.
      const pinned = pin ? await pinnedCatalogEntry(sourceOf(pin), pin, FREE_RESULT_RESERVE_BYTES, await moduleUsesVoice(admin, pin.moduleId)) : null;
      const catalog = pin ? withPinnedSkill(listed, pin, pinned) : listed;
      const prepared = await prepareSkills(catalog, sourceOf, FREE_RESULT_RESERVE_BYTES);
      const contentSource = pin && pinned ? await entryContentSource(sourceOf(pin), pinned, FREE_RESULT_RESERVE_BYTES) : undefined;
      return { catalog, prepared, ...(contentSource ? { contentSource } : {}) };
    },
    async voice(actorId, catalog) {
      const voice = await admitCatalogVoice(admin, actorId, catalog);
      return voice && { text: voice.text, ...(voice.frozen.versionId ? { versionId: voice.frozen.versionId } : {}) };
    },
    // Before turn_open: the old path's full source check, and the own-data tier (read-only, so no lock on the profile). Free members
    // get window 0 and read the "members only" note; an unknown tier means no post reads this turn.
    async workspace(actorId, configuration) {
      const postsOn = await admitOwnPosts(admin, true, 'ordinary', [], configuration);
      const [sources, tier] = await Promise.all([admin.rpc('opc_workspace_sources', { p_actor_id: actorId }),
        postsOn ? swallow('turn_tools_posts_tier_unavailable', readOwnDataTier(admin, actorId), null) : null]);
      if (sources.error) throw new Error('TURN_WORKSPACE_UNAVAILABLE');
      return { sources: sources.data as string[], strategy: true, posts: !tier ? null : { windowDays: tier.ownDataWindowDays,
        benchmarks: tier.level === 'gold' && tier.allowBenchmarkMonitor,
        review: rowFor(await configuration, REVIEW_SWITCH).data?.value === true } };
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
