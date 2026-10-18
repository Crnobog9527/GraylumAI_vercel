/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { FounderBadgeView } from './FounderBadge';
import { FounderWallForm, type WallSubmit } from './FounderWallForm';
import {
  canEditCard, founderMemberError, showsCard, statusLine, wallStatus, type FounderMemberView,
} from './founderMemberView';

const panel = { background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' };

export function FounderProfileCardView({ view, pending, error, onSubmit, onWithdraw }: {
  view: FounderMemberView; pending: boolean; error: string | null;
  onSubmit: (value: WallSubmit) => void; onWithdraw: () => void;
}) {
  const editable = canEditCard(view.founder.state);
  const status = wallStatus(view);
  return <div className="mt-6 rounded-2xl p-6" style={panel} data-testid="founder-profile-card">
    <div className="flex flex-wrap items-center gap-3">
      <h3 className="font-medium" style={{ color: 'var(--text-primary)' }}>创始会员</h3>
      <FounderBadgeView state={view.founder.state} />
    </div>
    <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>{statusLine(view)}</p>
    {view.community && (view.community.url || view.community.note) && <div className="mt-3 text-sm" data-testid="founder-community">
      <p className="font-medium" style={{ color: 'var(--text-primary)' }}>会员社群</p>
      {view.community.note && <p style={{ color: 'var(--text-secondary)' }}>{view.community.note}</p>}
      {view.community.url && <a href={view.community.url} target="_blank" rel="noopener noreferrer"
        className="underline" style={{ color: 'var(--color-primary)' }}>加入创始会员社群</a>}
    </div>}
    {(editable || view.entry) && <div className="mt-4 border-t pt-4" style={{ borderColor: 'var(--border-primary)' }}>
      <p className="font-medium" style={{ color: 'var(--text-primary)' }}>创始会员墙</p>
      <p className="mt-1 text-sm" style={{ color: 'var(--text-tertiary)' }}>
        愿意的话，可以把你的账号放到公开的创始会员墙上。默认不公开，只有你勾选同意并通过审核后才会展示。
      </p>
      {status && <p className="mt-2 text-sm" role="status" data-testid="founder-wall-status">{status}</p>}
      {editable && <FounderWallForm key={`${view.entry?.updatedAt ?? 'new'}-${view.consent.granted}`} view={view} pending={pending} serverError={error} onSubmit={onSubmit} />}
      {editable && view.entry && view.consent.granted && <Button type="button" variant="outline" size="sm" className="mt-3"
        disabled={pending} onClick={onWithdraw} data-testid="founder-wall-withdraw">撤回公开并下架</Button>}
    </div>}
  </div>;
}

/** Personal-center card: reads and changes only the signed-in member's own state. */
export function FounderProfileCard() {
  const utils = trpc.useUtils();
  const query = trpc.founder.me.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const submit = trpc.founder.submitWall.useMutation();
  const withdraw = trpc.founder.withdrawWall.useMutation();
  const [error, setError] = useState<string | null>(null);
  const pending = submit.isPending || withdraw.isPending;

  async function run(work: () => Promise<FounderMemberView>) {
    if (pending) return;
    setError(null);
    try {
      utils.founder.me.setData(undefined, await work() as never);
    } catch (cause) {
      setError(founderMemberError(cause as never));
      void query.refetch();
    }
  }

  if (query.error && !query.data) {
    return <div className="mt-6 rounded-2xl p-6" style={panel} role="alert" data-testid="founder-profile-error">
      <p className="text-sm">暂时无法读取你的创始会员信息，请重试。</p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { void query.refetch(); }}>重新读取</Button>
    </div>;
  }
  if (!showsCard(query.data as FounderMemberView | undefined)) return null;
  return <FounderProfileCardView view={query.data as FounderMemberView} pending={pending} error={error}
    onSubmit={value => void run(() => submit.mutateAsync(value as never) as Promise<FounderMemberView>)}
    onWithdraw={() => void run(() => withdraw.mutateAsync() as Promise<FounderMemberView>)} />;
}
