import type { SupabaseClient } from '@supabase/supabase-js';
import { isEmailVerified } from '../../lib/auth';
import { fail, sameIdentity, validateDescriptor, type PackageDescriptor, type PackageIdentity, type SkillSource } from './loader';

/** Request-local only. The authenticated client verifies identity and public module
 * admission before the narrowly scoped service RPC can return private content.
 * No browser route exports this source or accepts a caller-supplied actor ID.
 *
 * AC-0c: the user-scoped module admission (subject to RLS) is read once per
 * source, i.e. once per request. A caller that already made that same
 * user-scoped read of active modules in this request may pass the row it got.
 * A service-role read must never be passed: RLS may later differ per user.
 * Every service RPC still independently checks actor, module, publication and
 * revocation; nothing here survives the request. */
export function databaseSkillSource(options: {
  userClient: SupabaseClient; privateClient: SupabaseClient | null;
  moduleId: string; skillId: string; revisionId?: string;
  userVisibleModule?: { id: unknown; active: unknown };
}): SkillSource {
  options = { ...options };
  if (typeof window !== 'undefined') fail('UNAVAILABLE');
  let selected: PackageDescriptor | undefined;
  let admitted: Promise<void> | undefined;
  if (options.userVisibleModule) {
    // Fail closed on a row that does not prove this exact module is visible and active.
    if (options.userVisibleModule.id !== options.moduleId || options.userVisibleModule.active !== true) fail('UNAVAILABLE');
    admitted = Promise.resolve();
  }
  const moduleAdmission = () => {
    if (!admitted) {
      const check = (async () => {
        const visible = await options.userClient.from('modules').select('id,active').eq('id', options.moduleId).eq('active', true).single();
        if (visible.error || visible.data?.id !== options.moduleId) fail('UNAVAILABLE');
      })();
      // A denied or failed admission is never reused; the next read checks again.
      admitted = check.catch(error => { admitted = undefined; throw error; });
    }
    return admitted;
  };
  const read = async (identity?: PackageIdentity, path: string | null = null, maxBytes = 2097152) => {
    if (!options.privateClient) fail('UNAVAILABLE');
    const auth = await options.userClient.auth.getUser();
    const user = auth.data.user;
    if (auth.error || !user || !isEmailVerified(user)) fail('UNAVAILABLE');
    await moduleAdmission();
    const { data, error } = await options.privateClient.rpc('read_skill_package', {
      p_actor_id: user.id, p_module_id: options.moduleId, p_skill_id: options.skillId,
      p_revision_id: identity?.revisionId ?? options.revisionId ?? null,
      p_package_hash: identity?.packageHash ?? null, p_path: path, p_max_bytes: maxBytes,
    });
    if (error || data === null) fail('UNAVAILABLE');
    return data;
  };
  return {
    // The first listing is itself a full service check. Repeated listings return
    // the same immutable descriptor; callers reach them only through the loader,
    // which checks state immediately after (discoverSkills, activateSkill).
    async list() {
      if (!selected) selected = validateDescriptor(await read());
      return [structuredClone(selected)];
    },
    async state(identity) {
      if (!selected || !sameIdentity(selected,identity)) return 'denied';
      try { await read(identity,''); return 'enabled'; } catch { return 'denied'; }
    },
    async read(identity,maxBytes) {
      if (!selected || !sameIdentity(selected,identity)) fail('UNAVAILABLE');
      const data = await read(identity,identity.path,maxBytes);
      if (typeof data !== 'string') fail('SOURCE_FAILURE');
      return Buffer.from(data,'base64');
    },
  };
}
