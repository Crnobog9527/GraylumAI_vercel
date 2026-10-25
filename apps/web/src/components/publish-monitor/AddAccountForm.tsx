'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { trpc } from '@/trpc/client';
import { dataErrorMessage, errorCode, platformName } from './labels';

/**
 * PUBLISH-MONITOR: add a brand account without adopting a topic first (Owner 2026-10-23). It hangs on one of the user's
 * own positioning profiles (no profile is created here, so the profile limit is untouched). The server repeats every check.
 */
export const ADD_PLATFORMS = ['x', 'youtube', 'tiktok', 'instagram', 'facebook', 'threads', 'linkedin', 'pinterest',
  'bluesky', 'xiaohongshu', 'douyin'] as const;

/** Positioning profiles an account can hang on: live (not archived) and with a confirmed positioning (server rule too). */
export function eligibleProfiles(list: unknown): Array<{ businessId: string; name: string; createdAt: string }> {
  if (!Array.isArray(list)) return [];
  return list.flatMap(entry => {
    const b = entry as { businessId?: unknown; name?: unknown; isArchived?: unknown; currentSourceVersionId?: unknown;
      createdAt?: unknown };
    return typeof b.businessId === 'string' && b.isArchived !== true && typeof b.currentSourceVersionId === 'string'
      ? [{ businessId: b.businessId, name: typeof b.name === 'string' && b.name ? b.name : '未命名定位档案',
        createdAt: typeof b.createdAt === 'string' ? b.createdAt : '' }] : [];
  });
}

/**
 * Several profiles can carry the same name (every one started without a name is "未命名业务"), and an account name can live
 * in only one of them, so the picker tells them apart by creation date, and by a short code when the dates match too.
 */
export function profileLabels(profiles: Array<{ businessId: string; name: string; createdAt: string }>): Map<string, string> {
  const day = (iso: string) => (iso ? iso.slice(0, 10) : '');
  const same = (a: typeof profiles[number], b: typeof profiles[number]) => a.name === b.name;
  return new Map(profiles.map(profile => {
    const twins = profiles.filter(other => same(profile, other));
    if (twins.length === 1) return [profile.businessId, profile.name] as const;
    const date = day(profile.createdAt);
    const dateTwins = twins.filter(other => day(other.createdAt) === date);
    const code = dateTwins.length > 1 ? ` #${profile.businessId.slice(0, 4)}` : '';
    return [profile.businessId, `${profile.name}（创建于 ${date || '未知'}${code}）`] as const;
  }));
}

export function AddAccountForm({ onAdded }: { onAdded: (projectId: string) => void }) {
  const profiles = trpc.opc.businesses.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const brands = eligibleProfiles(profiles.data);
  const labels = profileLabels(brands);
  const [businessId, setBusinessId] = useState('');
  const [platform, setPlatform] = useState<string>(''), [account, setAccount] = useState('');
  const add = trpc.publishMonitor.addAccount.useMutation();
  if (profiles.isLoading) return <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>正在读取定位档案…</p>;
  if (profiles.error) return <p role="alert" className="text-sm" style={{ color: 'var(--color-error)' }}>
    暂时读不到你的定位档案，请稍后重试。</p>;
  if (brands.length === 0) return <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
    还没有已确认定位的定位档案。先去"定位"完成并确认一个定位，这里才能添加账号。</p>;
  const chosen = businessId || (brands.length === 1 ? brands[0]!.businessId : '');
  const ready = Boolean(chosen && platform && account.trim());
  return (
    <fieldset className="space-y-2 rounded-md border p-3 text-sm" style={{ borderColor: 'var(--border-primary)' }}>
      <legend className="px-1 font-medium">添加品牌账号</legend>
      <p style={{ color: 'var(--text-secondary)' }}>账号会挂在你已经确认过定位的档案下，一个平台一个账号。添加后就能连接它。</p>
      {brands.length > 1 && (
        <select className="w-full rounded-md border px-2 py-1.5" style={{ borderColor: 'var(--border-primary)' }}
          value={businessId} onChange={event => setBusinessId(event.target.value)} aria-label="定位档案">
          <option value="">选择定位档案</option>
          {brands.map(brand => <option key={brand.businessId} value={brand.businessId}>{labels.get(brand.businessId)}</option>)}
        </select>
      )}
      <select className="w-full rounded-md border px-2 py-1.5" style={{ borderColor: 'var(--border-primary)' }}
        value={platform} onChange={event => setPlatform(event.target.value)} aria-label="平台">
        <option value="">选择平台</option>
        {ADD_PLATFORMS.map(code => <option key={code} value={code}>{platformName(code)}</option>)}
      </select>
      <Input aria-label="账号名" placeholder="账号名，例如 your_handle（小写字母、数字和 . _ : -）" maxLength={128} value={account}
        onChange={event => setAccount(event.target.value)} />
      {add.error && <p role="alert" style={{ color: 'var(--color-error)' }}>{dataErrorMessage(errorCode(add.error))}</p>}
      <Button disabled={!ready || add.isPending} onClick={() => add.mutate({ businessId: chosen,
        platform: platform as typeof ADD_PLATFORMS[number], account: account.trim() }, {
        onSuccess: result => { setAccount(''); onAdded(result.accountProjectId); } })}>
        {add.isPending ? '添加中…' : '添加账号'}</Button>
    </fieldset>
  );
}
