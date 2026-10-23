'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { platformName, publishErrorMessage, publishTargets, type Connection } from '@/lib/publish-monitor/publish-flow';
import { clearAttempt, loadAttempt } from '@/lib/publish-monitor/publish-recovery';
import { trpc } from '@/trpc/client';
import { PublishForm } from './publish-form';
import { PublishStatus } from './publish-status';

/**
 * PUBLISH-MONITOR PR-5: one-click publishing of one topic (?item=<work item id>) or of one saved result of a free
 * conversation's results folder (?result=<result family id>) to the brand's connected overseas accounts. A result has no
 * brand of its own, so the user picks one of their brands that has a connected account (no topic is attached to the
 * job). Only platforms an admin opened after their real publishing check are listed; the server refuses others.
 */
type Version = { kind: string; version: number; status: 'draft' | 'final'; body: string | null; contentAvailable: boolean };
type Item = { workItemId: string; title: string; contentType?: string; content: Version[] };
type Account = { projectId: string; platform: string; items: Item[] };
type Business = { businessId: string; name: string; accounts: Account[] };
type ResultVersion = { version: number; title: string; body: string };
type Source = { kind: 'item' | 'result'; id: string; sessionId?: string };

// A topic keeps the keys the first release used (a tab opened before an update still finds its job and saved request);
// only results are namespaced.
const JOB_KEY = (source: Source) => source.kind === 'item' ? `publish-monitor-job:${source.id}` : `publish-monitor-job:result:${source.id}`;
const BACK = (source: Source) => source.kind === 'item' ? `/app/library?item=${source.id}`
  : source.sessionId ? `/app/runtime?session=${source.sessionId}` : '/app/runtime';
const BRAND_KEY = (source: Source) => `publish-monitor-brand:${source.id}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The latest final draft is the starting caption; a video script is not a caption, so a video starts from its title. */
function startingCaption(item: Item): string {
  if (item.contentType === 'video') return item.title;
  const final = item.content.filter(v => v.status === 'final' && v.contentAvailable && v.body)
    .sort((a, b) => b.version - a.version)[0];
  return final?.body ?? item.title;
}

function Workbench({ source }: { source: Source }) {
  const isItem = source.kind === 'item';
  const library = trpc.opc.library.useQuery({ search: '', from: null, to: null }, { retry: false });
  const versions = trpc.opc.sessionResultVersions.useQuery({ familyId: source.id }, { retry: false, enabled: !isItem });
  const connections = trpc.publishMonitor.connections.useQuery(undefined, { retry: false });
  const options = trpc.publishMonitor.publish.options.useQuery(undefined, { retry: false });
  const [jobId, setJobId] = useState<string | null>(null);
  const [retryTargets, setRetryTargets] = useState<string[] | null>(null);
  const [round, setRound] = useState(0);
  const [pickedBrand, setPickedBrand] = useState('');
  const [pending, setPending] = useState(false);
  const storageKey = JOB_KEY(source);
  // A job in progress survives a reload: only its id is kept, never a media link.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved && UUID.test(saved)) setJobId(saved);
      // The brand an unconfirmed result publish was started with comes back after a reload, with its saved attempt.
      const brand = sessionStorage.getItem(BRAND_KEY(source));
      if (brand && UUID.test(brand)) setPickedBrand(brand);
    } catch { /* storage unavailable: the page still works without it */ }
  }, [storageKey]); // eslint-disable-line react-hooks/exhaustive-deps
  function remember(id: string | null) {
    setJobId(id);
    try {
      if (id) sessionStorage.setItem(storageKey, id); else sessionStorage.removeItem(storageKey);
    } catch { /* see above */ }
  }
  const back = <Link className="text-sm underline" href={BACK(source)}>{isItem ? '回到资料库' : '回到对话'}</Link>;

  // A saved job comes first and needs none of the new-publish queries: while the feature is paused or the plan has lapsed
  // those fail, but the job (and the credits it holds) must stay visible and refreshable.
  if (jobId) {
    return (
      <div className="space-y-6">
        <h1 className="text-xl font-semibold">一键发布</h1>
        <PublishStatus jobId={jobId} onDone={() => remember(null)}
          onRetry={ids => { setRetryTargets(ids); setRound(round + 1); remember(null); }} />
        {back}
      </div>
    );
  }
  const failure = connections.error ?? options.error ?? library.error ?? (isItem ? null : versions.error);
  if (failure) return <p role="alert">{publishErrorMessage(failure.message, failure.data?.code)}</p>;
  if (!library.data || !connections.data || !options.data || (!isItem && !versions.data)) {
    return <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }
  const businesses = (library.data.businesses ?? []) as Business[];
  const all = connections.data as Connection[];
  const open = options.data.platforms;

  if (isItem) {
    const found = businesses.flatMap(business => business.accounts.flatMap(account => account.items
      .filter(item => item.workItemId === source.id).map(item => ({ business, account, item }))))[0];
    if (!found) return <p role="alert">找不到这条选题，或者它不属于你。</p>;
    const targets = publishTargets(all, found.business.businessId, open);
    const own = targets.find(t => t.accountProjectId === found.account.projectId);
    return (
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">一键发布</h1>
          <p className="text-sm text-[var(--text-secondary)]">{found.business.name} · {found.item.title}</p>
        </header>
        <PublishForm key={round} businessId={found.business.businessId} workItemId={source.id} contextKey={source.id}
          targets={targets} initialCaption={startingCaption(found.item)} initialTargets={retryTargets ?? (own ? [own.id] : [])}
          holdCreditsByTargets={options.data.holdCreditsByTargets} onSubmitted={remember} />
        {back}
      </div>
    );
  }

  const latest = ((versions.data ?? []) as ResultVersion[]).reduce<ResultVersion | null>(
    (best, v) => (!best || v.version > best.version ? v : best), null);
  if (!latest) return <p role="alert">找不到这条成果，或者它已被删除。</p>;
  // Brands that have at least one connected account on an open platform; the user chooses which brand's accounts publish.
  const brands = businesses.map(business => ({ business, targets: publishTargets(all, business.businessId, open) }))
    .filter(entry => entry.targets.length > 0);
  // An unconfirmed publish stays with the brand it was started with, whatever is eligible now: another brand is never
  // chosen for it silently (a new request under a new key could publish and charge twice).
  const stuckBrand = pickedBrand && !brands.some(entry => entry.business.businessId === pickedBrand)
    && loadAttempt(`result:${source.id}:${pickedBrand}`) !== null;
  const chosen = brands.find(entry => entry.business.businessId === pickedBrand)
    ?? (!pickedBrand && brands.length === 1 ? brands[0]! : null);
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">一键发布</h1>
        <p className="text-sm text-[var(--text-secondary)]">成果夹 · {latest.title}</p>
      </header>
      {stuckBrand && (
        <div role="status" className="space-y-2 rounded border border-[var(--border-default)] p-3 text-sm">
          <p>上一次发布还没有确认结果，可能已经发出，但它用的品牌账号现在不能用了
            （可能已断开，或这个平台暂时关闭）。请先去平台确认有没有发出。</p>
          <button type="button" className="underline" onClick={() => {
            clearAttempt(`result:${source.id}:${pickedBrand}`);
            try { sessionStorage.removeItem(BRAND_KEY(source)); } catch { /* optional */ }
            setPickedBrand('');
          }}>确认过了，放弃上一次，重新开始</button>
        </div>
      )}
      {brands.length === 0 ? (
        <p className="text-sm text-[var(--text-secondary)]">
          你还没有可以一键发布的账号：先在"数据复盘"页连接海外平台账号；只显示已经开放一键发布的平台。</p>
      ) : (
        <>
          {brands.length > 1 && (
            <label className="block space-y-1 text-sm">
              <span className="font-medium">用哪个品牌的账号发布</span>
              <select className="w-full rounded-md border px-2 py-1.5" value={chosen?.business.businessId ?? ''}
                aria-label="品牌" disabled={pending}
                onChange={event => {
                  setPickedBrand(event.target.value); setRetryTargets(null);
                  try { sessionStorage.setItem(BRAND_KEY(source), event.target.value); } catch { /* optional */ }
                }}>
                <option value="">请选择</option>
                {brands.map(entry => (
                  <option key={entry.business.businessId} value={entry.business.businessId}>
                    {entry.business.name}（{entry.targets.map(t => platformName(t.platform)).join('、')}）</option>
                ))}
              </select>
            </label>
          )}
          {chosen && (
            <PublishForm key={`${round}:${chosen.business.businessId}`} businessId={chosen.business.businessId} workItemId={null}
              contextKey={`result:${source.id}:${chosen.business.businessId}`} onPendingChange={setPending}
              targets={chosen.targets} initialCaption={latest.body}
              initialTargets={retryTargets ?? (chosen.targets.length === 1 && chosen.targets[0]!.ready ? [chosen.targets[0]!.id] : [])}
              holdCreditsByTargets={options.data.holdCreditsByTargets} onSubmitted={remember} />
          )}
        </>
      )}
      {back}
    </div>
  );
}

function PublishPage() {
  const params = useSearchParams();
  const item = params.get('item');
  const result = params.get('result');
  const session = params.get('session');
  const source: Source | null = item && UUID.test(item) ? { kind: 'item', id: item }
    : result && UUID.test(result)
      ? { kind: 'result', id: result, ...(session && UUID.test(session) ? { sessionId: session } : {}) } : null;
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      {source ? <Workbench source={source} /> : <p role="alert">请从资料库里的选题，或对话的成果夹里打开一键发布。</p>}
    </main>
  );
}

export default function Page() {
  return <Suspense><PublishPage /></Suspense>;
}
