/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicalAccount, type CanonicalAccount } from '../research/tools/accountLinks';
import type { SocialPlatform } from '../research/vendors/types';
import { discoverSkillCatalog, entryContentSource, moduleUsesVoice, pinnedCatalogEntry } from './skills/skillCatalog';
import { admitCatalogVoice } from './admission/voiceCatalog';
import { swallow } from '../../lib/swallow';
import { readOwnDataTier } from '../membershipEntitlements';
import { COACH_SWITCH, REVIEW_SWITCH } from '../publishMonitor/reviewSettings';
import { rowFor } from './settings/settingsRows';
import { admitOwnPosts } from './agent/workspacePosts';
import { databaseSkillSource, requestAuthentication, userVisibleModules } from '../skills/databaseSource';
import type { ChatToolDeps } from './tools/chatTools';
import { FREE_RESULT_RESERVE_BYTES } from './tools/plan';
import { prepareSkills, withPinnedSkill } from './tools/skills';
import { memberCatalog } from './skills/coachGate';

/*
 * CORE-PATH-V2 V2-6: what POST /api/turn gives a free chat for its tools. All of it runs before turn_open: the Skill catalog with
 * each entry's load result (cached by package hash), the catalog voice and the accounts social_account may look up. The list holds
 * the social Skills too: whether this account may see them is known at turn_open, and chat.ts drops them there.
 */
export function chatToolDeps(admin: SupabaseClient, user: () => SupabaseClient): ChatToolDeps {
  // One plan read per request (this object is made for one request): the Skill list and the workspace both ask for it.
  let ownTier: ReturnType<typeof readOwnDataTier> | undefined;
  const tierOf = (actorId: string) => (ownTier ??= readOwnDataTier(admin, actorId));
  return {
    library: true,
    async skills(actorId, pin) {
      const client = user();
      // The request's reads shared by every Skill below: who the caller is (asked once) and which modules the caller can see
      // (read once, now, by this request; each source then takes its module's row from it instead of reading it again).
      const request = { visible: userVisibleModules(client, { limit: 65, orderById: true }), authentication: requestAuthentication(client) };
      const listing = discoverSkillCatalog(client, admin, { maxResultBytes: FREE_RESULT_RESERVE_BYTES, excludeSocial: false, actorId, request });
      const [listed, visible] = await Promise.all([listing, request.visible]);
      // A module the caller cannot see in that read gets no row, so its source checks for itself and is refused as before.
      const sourceOf = (entry: { moduleId: string; skillId: string; revisionId: string }) => {
        const row = visible.error ? undefined : visible.data.find(module => module.id === entry.moduleId);
        return databaseSkillSource({ userClient: client, privateClient: admin, moduleId: entry.moduleId, skillId: entry.skillId,
          revisionId: entry.revisionId, authentication: request.authentication, ...(row ? { userVisibleModule: row } : {}) });
      };
      // A work item's method is the revision it is bound to, in place of what the catalog lists for its module.
      const pinned = pin ? await pinnedCatalogEntry(sourceOf(pin), pin, FREE_RESULT_RESERVE_BYTES, await moduleUsesVoice(admin, pin.moduleId)) : null;
      // After the pin is put in: a work item pinned to the coach Skill before a downgrade must not bring the member method back.
      const catalog = await memberCatalog(admin, actorId, pin ? withPinnedSkill(listed, pin, pinned) : listed, tierOf);
      const prepared = await prepareSkills(catalog, sourceOf, FREE_RESULT_RESERVE_BYTES);
      const pinnedListed = pinned !== null && catalog.some(entry => entry.revisionId === pinned.revisionId);
      const contentSource = pin && pinned && pinnedListed ? await entryContentSource(sourceOf(pin), pinned, FREE_RESULT_RESERVE_BYTES) : undefined;
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
        postsOn ? swallow('turn_tools_posts_tier_unavailable', tierOf(actorId), null) : null]);
      if (sources.error) throw new Error('TURN_WORKSPACE_UNAVAILABLE');
      const on = async (key: string) => rowFor(await configuration, key).data?.value === true;
      return { sources: sources.data as string[], strategy: true, posts: !tier ? null : { windowDays: tier.ownDataWindowDays,
        benchmarks: tier.level === 'gold' && tier.allowBenchmarkMonitor, review: await on(REVIEW_SWITCH), coach: await on(COACH_SWITCH) } };
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
