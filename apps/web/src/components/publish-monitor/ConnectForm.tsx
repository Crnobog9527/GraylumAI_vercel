'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { connectErrorMessage } from '@/lib/publish-monitor-messages';
import { trpc } from '@/trpc/client';
import { AddAccountForm } from './AddAccountForm';
import type { Brand, BrandAccount } from './brands';
import { COMBINED_AUTH_PLATFORMS, connectRoute, dataErrorMessage, errorCode, platformName } from './labels';

/**
 * PUBLISH-MONITOR PR-7 (plan §4.1, §4.2): connect one of the user's brand accounts. Overseas platforms go to the
 * Post for Me consent page with read-only access requested; Xiaohongshu and Douyin are read from a public profile
 * link. Nothing here asks for publishing access (that is a separate, later consent).
 */
type StartBody = { accountProjectId: string; publish: false; connectionType?: 'instagram' | 'facebook';
  bluesky?: { handle: string; appPassword: string } };

export async function startPostForMe(body: StartBody, assign: (url: string) => void = url => location.assign(url)) {
  const response = await fetch('/api/publish-monitor/connect/start', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => null) as { url?: unknown; error?: unknown } | null;
  if (!response.ok || typeof json?.url !== 'string') {
    throw new Error(typeof json?.error === 'string' ? json.error : 'PUBLISH_MONITOR_UNAVAILABLE');
  }
  assign(json.url);
}

export function ConnectForm({ brands, connected, initialProjectId = '', onConnected, onAccountAdded }: { brands: Brand[];
  connected: Set<string>; initialProjectId?: string; onConnected: () => void; onAccountAdded?: () => void }) {
  const accounts = brands.flatMap(brand => brand.accounts);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [addOpen, setAddOpen] = useState(false);
  const account = accounts.find(a => a.projectId === projectId) ?? null;
  return (
    <div className="space-y-3 rounded-lg border p-4" style={{ borderColor: 'var(--border-primary)' }}>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">选择要连接的品牌账号</span>
        <select className="w-full rounded-md border px-2 py-1.5" style={{ borderColor: 'var(--border-primary)' }}
          value={projectId} onChange={event => setProjectId(event.target.value)} aria-label="品牌账号">
          <option value="">请选择</option>
          {brands.map(brand => (
            <optgroup key={brand.businessId} label={brand.name}>
              {brand.accounts.map(a => (
                <option key={a.projectId} value={a.projectId}
                  disabled={connected.has(a.projectId) || connectRoute(a.platform) === 'unsupported'}>
                  {platformName(a.platform)} · {a.label}
                  {connected.has(a.projectId) ? '（已连接）' : connectRoute(a.platform) === 'unsupported' ? '（暂不支持）' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {(addOpen || accounts.length === 0) ? <AddAccountForm
        onAdded={id => { setAddOpen(false); setProjectId(id); onAccountAdded?.(); }} />
        : <button type="button" className="text-sm underline" onClick={() => setAddOpen(true)}>没有想要的账号？添加品牌账号</button>}
      {account && connectRoute(account.platform) === 'postforme' && <PostForMeStart key={account.projectId} account={account} />}
      {account && connectRoute(account.platform) === 'profile_link'
        && <ProfileLinkConnect key={account.projectId} account={account} onConnected={onConnected} />}
    </div>
  );
}

function PostForMeStart({ account }: { account: BrandAccount }) {
  const [connectionType, setConnectionType] = useState<'instagram' | 'facebook'>('instagram');
  const [handle, setHandle] = useState(''), [appPassword, setAppPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const combined = COMBINED_AUTH_PLATFORMS.includes(account.platform);
  const bluesky = account.platform === 'bluesky';
  async function start() {
    setBusy(true); setError('');
    try {
      await startPostForMe({ accountProjectId: account.projectId, publish: false,
        ...(account.platform === 'instagram' ? { connectionType } : {}),
        ...(bluesky ? { bluesky: { handle: handle.trim(), appPassword: appPassword.trim() } } : {}) });
    } catch (cause) {
      setError(connectErrorMessage(errorCode(cause)));
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2 text-sm">
      <p style={{ color: 'var(--text-secondary)' }}>
        接下来会跳到授权页（页面上显示的是连接服务 Post for Me 的名字）。只请求读取作品数据，不会发布任何内容；
        授权后回到 Graylum 确认要连接哪个账号。</p>
      {combined && <p role="note" className="rounded-md p-2" style={{ background: 'var(--bg-secondary)' }}>
        {platformName(account.platform)} 不能只授权读取：这一步也会授予发布能力，但在你单独同意之前，我们不会发布任何内容。</p>}
      {account.platform === 'instagram' && (
        <fieldset className="space-y-1">
          <legend>Instagram 账号的登录方式（只支持专业账号：商家或创作者）</legend>
          <label className="mr-4"><input type="radio" name="ig" checked={connectionType === 'instagram'}
            onChange={() => setConnectionType('instagram')} /> 用 Instagram 登录</label>
          <label><input type="radio" name="ig" checked={connectionType === 'facebook'}
            onChange={() => setConnectionType('facebook')} /> 通过关联的 Facebook 主页登录</label>
        </fieldset>
      )}
      {account.platform === 'linkedin' && <p style={{ color: 'var(--text-secondary)' }}>
        LinkedIn 只有公司主页能读到作品数据，个人主页读不到。</p>}
      {bluesky && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input aria-label="Bluesky 账号" placeholder="账号，例如 name.bsky.social" value={handle}
            onChange={event => setHandle(event.target.value)} maxLength={253} />
          <Input aria-label="Bluesky 应用密码" placeholder="应用密码（在 Bluesky 设置里生成）" value={appPassword}
            onChange={event => setAppPassword(event.target.value)} maxLength={19} type="password" autoComplete="off" />
        </div>
      )}
      {error && <p role="alert" style={{ color: 'var(--color-error)' }}>{error}</p>}
      <Button disabled={busy || (bluesky && (!handle.trim() || !appPassword.trim()))} onClick={start}>去授权</Button>
    </div>
  );
}

function ProfileLinkConnect({ account, onConnected }: { account: BrandAccount; onConnected: () => void }) {
  const [link, setLink] = useState(''), [autoTrack, setAutoTrack] = useState(false);
  const connect = trpc.publishMonitor.connectTikhub.useMutation();
  return (
    <div className="space-y-2 text-sm">
      <p style={{ color: 'var(--text-secondary)' }}>
        粘贴你在{platformName(account.platform)}的个人主页链接。我们读取的是公开数据，不需要授权；每次读取按实际费用扣积分。</p>
      <Input aria-label="主页链接" placeholder="https://" value={link} maxLength={2048}
        onChange={event => setLink(event.target.value)} />
      <label className="flex items-center gap-2">
        <Checkbox checked={autoTrack} onCheckedChange={value => setAutoTrack(value === true)} />
        每天自动更新作品数据（每次读取按实际费用扣积分；不勾选就不会读取，以后可以断开后重新连接再勾选）
      </label>
      {connect.error && <p role="alert" style={{ color: 'var(--color-error)' }}>{dataErrorMessage(errorCode(connect.error))}</p>}
      {connect.data && <p role="status">已连接，作品数据会在下次更新后出现。</p>}
      <Button disabled={!link.trim() || connect.isPending}
        onClick={() => connect.mutate({ accountProjectId: account.projectId, profileLink: link.trim(), autoTrack },
          { onSuccess: onConnected })}>连接</Button>
    </div>
  );
}
