import type { SupabaseClient } from '@supabase/supabase-js';

export async function loadInvitationSummary(supabase: SupabaseClient, profileId: string) {
  const countQuery = () => supabase
    .from('invitation_records')
    .select('status', { count: 'exact', head: true })
    .eq('inviter_id', profileId);
  const results = await Promise.all([
    countQuery(),
    countQuery().eq('status', 'rewarded'),
    countQuery().in('status', ['pending', 'registered']),
  ]);
  const [totalInvites, rewardedInvites, pendingInvites] = results.map(({ count, error }) => {
    if (error) throw error;
    if (count === null) throw new Error('Invitation count unavailable');
    return count;
  });
  return { totalInvites, rewardedInvites, pendingInvites };
}
