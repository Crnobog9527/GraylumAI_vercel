import type { SupabaseClient } from '@supabase/supabase-js';
import { fail, identityOf, sameIdentity, validateDescriptor, type PackageDescriptor, type PackageIdentity, type SkillSource } from './loader';

/** Request-local only. The authenticated client verifies identity and public module
 * admission before the narrowly scoped service RPC can return private content.
 * No browser route exports this source or accepts a caller-supplied actor ID. */
export function databaseSkillSource(options: {
  userClient: SupabaseClient; privateClient: SupabaseClient | null;
  moduleId: string; skillId: string; revisionId?: string;
}): SkillSource {
  options = { ...options };
  if (typeof window !== 'undefined') fail('UNAVAILABLE');
  let selected: PackageDescriptor | undefined;
  const read = async (identity?: PackageIdentity, path: string | null = null, maxBytes = 2097152) => {
    if (!options.privateClient) fail('UNAVAILABLE');
    const auth = await options.userClient.auth.getUser();
    const user = auth.data.user;
    if (auth.error || !user || !user.email_confirmed_at) fail('UNAVAILABLE');
    const visible = await options.userClient.from('modules').select('id,active').eq('id',options.moduleId).eq('active',true).single();
    if (visible.error || visible.data?.id !== options.moduleId) fail('UNAVAILABLE');
    const { data, error } = await options.privateClient.rpc('read_skill_package', {
      p_actor_id: user.id, p_module_id: options.moduleId, p_skill_id: options.skillId,
      p_revision_id: identity?.revisionId ?? options.revisionId ?? null,
      p_package_hash: identity?.packageHash ?? null, p_path: path, p_max_bytes: maxBytes,
    });
    if (error || data === null) fail('UNAVAILABLE');
    return data;
  };
  return {
    async list() {
      if (!selected) selected = validateDescriptor(await read());
      else await read(identityOf(selected), '');
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
