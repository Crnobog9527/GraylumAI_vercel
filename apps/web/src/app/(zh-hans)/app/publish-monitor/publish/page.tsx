'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { publishErrorMessage, publishTargets, type Connection } from '@/lib/publish-monitor/publish-flow';
import { trpc } from '@/trpc/client';
import { PublishForm } from './publish-form';
import { PublishStatus } from './publish-status';

/**
 * PUBLISH-MONITOR PR-5: one-click publishing of one topic (?item=<work item id>) to the brand's connected overseas
 * accounts. Only platforms an admin opened after their real publishing check are listed; the server refuses others.
 */
type Version = { kind: string; version: number; status: 'draft' | 'final'; body: string | null; contentAvailable: boolean };
type Item = { workItemId: string; title: string; contentType?: string; content: Version[] };
type Account = { projectId: string; platform: string; items: Item[] };
type Business = { businessId: string; name: string; accounts: Account[] };

const JOB_KEY = (item: string) => `publish-monitor-job:${item}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The latest final draft is the starting caption; a video script is not a caption, so a video starts from its title. */
function startingCaption(item: Item): string {
  if (item.contentType === 'video') return item.title;
  const final = item.content.filter(v => v.status === 'final' && v.contentAvailable && v.body)
    .sort((a, b) => b.version - a.version)[0];
  return final?.body ?? item.title;
}

function Workbench({ workItemId }: { workItemId: string }) {
  const library = trpc.opc.library.useQuery({ search: '', from: null, to: null }, { retry: false });
  const connections = trpc.publishMonitor.connections.useQuery(undefined, { retry: false });
  const options = trpc.publishMonitor.publish.options.useQuery(undefined, { retry: false });
  const [jobId, setJobId] = useState<string | null>(null);
  const [retryTargets, setRetryTargets] = useState<string[] | null>(null);
  const [round, setRound] = useState(0);
  // A job in progress survives a reload: only its id is kept, never a media link.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(JOB_KEY(workItemId));
      if (saved && UUID.test(saved)) setJobId(saved);
    } catch { /* storage unavailable: the page still works without it */ }
  }, [workItemId]);
  function remember(id: string | null) {
    setJobId(id);
    try {
      if (id) sessionStorage.setItem(JOB_KEY(workItemId), id); else sessionStorage.removeItem(JOB_KEY(workItemId));
    } catch { /* see above */ }
  }

  const failure = library.error ?? connections.error ?? options.error;
  if (failure) return <p role="alert">{publishErrorMessage(failure.message, failure.data?.code)}</p>;
  if (!library.data || !connections.data || !options.data) {
    return <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }
  const businesses = (library.data.businesses ?? []) as Business[];
  const found = businesses.flatMap(business => business.accounts.flatMap(account => account.items
    .filter(item => item.workItemId === workItemId).map(item => ({ business, account, item }))))[0];
  if (!found) return <p role="alert">找不到这条选题，或者它不属于你。</p>;
  const targets = publishTargets(connections.data as Connection[], found.business.businessId, options.data.platforms);
  const own = targets.find(t => t.accountProjectId === found.account.projectId);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">一键发布</h1>
        <p className="text-sm text-[var(--text-secondary)]">{found.business.name} · {found.item.title}</p>
      </header>
      {jobId ? (
        <PublishStatus jobId={jobId} onDone={() => remember(null)}
          onRetry={ids => { setRetryTargets(ids); setRound(round + 1); remember(null); }} />
      ) : (
        <PublishForm key={round} businessId={found.business.businessId} workItemId={workItemId} targets={targets}
          initialCaption={startingCaption(found.item)} initialTargets={retryTargets ?? (own ? [own.id] : [])}
          holdCreditsByTargets={options.data.holdCreditsByTargets} onSubmitted={remember} />
      )}
      <Link className="text-sm underline" href={`/app/library?item=${workItemId}`}>回到资料库</Link>
    </div>
  );
}

function PublishPage() {
  const item = useSearchParams().get('item');
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      {item && UUID.test(item) ? <Workbench workItemId={item} /> : <p role="alert">请从资料库里的选题打开一键发布。</p>}
    </main>
  );
}

export default function Page() {
  return <Suspense><PublishPage /></Suspense>;
}
