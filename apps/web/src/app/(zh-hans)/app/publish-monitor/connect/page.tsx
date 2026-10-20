'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { connectErrorMessage } from '@/lib/publish-monitor-messages';
import { trpc } from '@/trpc/client';

/**
 * PUBLISH-MONITOR PR-2b-2 confirmation page (plan §4.1): nothing is written until the user picks one account here.
 * Account details come only from the server's read of this user's own pending attempt.
 */
const PLATFORM_NAMES: Record<string, string> = { x: 'X', youtube: 'YouTube', tiktok: 'TikTok', tiktok_business: 'TikTok 商业号',
  instagram: 'Instagram', facebook: 'Facebook', threads: 'Threads', linkedin: 'LinkedIn', pinterest: 'Pinterest', bluesky: 'Bluesky' };
const platformName = (p: string) => PLATFORM_NAMES[p] ?? p;

function Message({ title, text }: { title: string; text: string }) {
  return (
    <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{text}</CardDescription></CardHeader></Card>
  );
}

function ConnectConfirm({ requestId, providerFailed, ownedElsewhere }: { requestId: string; providerFailed: boolean;
  ownedElsewhere: boolean }) {
  const pending = trpc.publishMonitor.connect.pending.useQuery({ requestId }, { retry: false, refetchOnWindowFocus: false });
  const confirm = trpc.publishMonitor.connect.confirm.useMutation();
  const cancel = trpc.publishMonitor.connect.cancel.useMutation();
  const [picked, setPicked] = useState<string | null>(null);
  const [autoTrack, setAutoTrack] = useState(false);

  if (confirm.data) return <Message title="连接成功" text="已连接。可以回到账号页查看作品数据。" />;
  if (cancel.data) return <Message title="已取消" text="没有连接任何账号；这次授权导入的新账号会被清理。" />;
  if (pending.isLoading) return <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  if (pending.error || !pending.data) return <Message title="无法继续" text={connectErrorMessage(pending.error?.message)} />;

  const data = pending.data;
  const selectable = data.candidates.filter(c => c.kind !== 'unavailable');
  const publish = data.permissions.includes('posts');
  const busy = confirm.isPending || cancel.isPending;
  const failure = confirm.error ?? cancel.error;
  return (
    <Card>
      <CardHeader>
        <CardTitle>确认要连接的账号</CardTitle>
        <CardDescription>
          挂到品牌账号：{data.target.businessName ?? '你的品牌'} · {platformName(data.target.platform)} · {data.target.accountKey}
          <br />权限：{publish ? '读取作品数据，并允许以后在你确认后一键发布' : '只读取作品数据（不会发布任何内容）'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {providerFailed && <p className="text-sm text-[var(--text-secondary)]">授权页报告没有完成授权。</p>}
        {ownedElsewhere && <p className="text-sm text-[var(--text-secondary)]">
          这次带回的账号里，有的已被其他 Graylum 用户连接，没有列出。请联系对方，或换一个账号。</p>}
        {selectable.length === 0 ? <p className="text-sm">这次授权没有带回可以连接的账号，请重新连接或取消。</p> : (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">选择 1 个账号（没选的会从连接服务里删除）</legend>
            {data.candidates.map(c => (
              <label key={c.providerAccountId} className="flex items-center gap-2 text-sm">
                <input type="radio" name="account" value={c.providerAccountId} disabled={c.kind === 'unavailable' || busy}
                  checked={picked === c.providerAccountId} onChange={() => setPicked(c.providerAccountId)} />
                <span>{c.username ?? c.providerAccountId}</span>
                {c.kind === 'target' && <span className="text-[var(--text-secondary)]">（当前已连接，确认后更新授权）</span>}
                {c.kind === 'unavailable' && <span className="text-[var(--text-secondary)]">（不可用）</span>}
              </label>
            ))}
          </fieldset>
        )}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={autoTrack} onCheckedChange={v => setAutoTrack(v === true)} disabled={busy} />
          每天自动更新作品数据（不勾选时只在你手动刷新时读取）
        </label>
        {failure && <p className="text-sm text-[var(--color-error)]">{connectErrorMessage(failure.message)}</p>}
        <div className="flex gap-2">
          <Button disabled={!picked || busy}
            onClick={() => picked && confirm.mutate({ requestId, providerAccountId: picked, autoTrack })}>确认连接</Button>
          <Button variant="outline" disabled={busy} onClick={() => cancel.mutate({ requestId })}>取消</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ConnectPage() {
  const params = useSearchParams();
  const requestId = params.get('request');
  const error = params.get('error');
  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      {error || !requestId ? <Message title="无法继续" text={connectErrorMessage(error)} />
        : <ConnectConfirm requestId={requestId} providerFailed={params.get('provider') === 'failed'}
          ownedElsewhere={params.get('ownedElsewhere') === '1'} />}
    </main>
  );
}

export default function Page() {
  return <Suspense><ConnectPage /></Suspense>;
}
