'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { createClient } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { confirmedInformationMarkdown, downloadInformation, informationExportIdentity,
  EXPORT_CHANGED, EXPORT_EMPTY, EXPORT_FAILED } from './information-export';

export function InformationExport({ draftId, current }: { draftId: string; current: unknown }) {
  const utils = trpc.useUtils();
  const [auth] = useState(() => createClient().auth);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const inFlight = useRef(false);
  const epoch = useRef({ value: 0 });
  const latest = useRef({ draftId, current });
  useEffect(() => { latest.current = { draftId, current }; }, [draftId, current]);
  useEffect(() => {
    const lifetime = epoch.current;
    let actor: string | null | undefined;
    const { data: { subscription } } = auth.onAuthStateChange((_event, session) => {
      const next = session?.user.id ?? null;
      if (actor !== undefined && actor !== next) lifetime.value++;
      actor = next;
    });
    return () => { lifetime.value++; subscription.unsubscribe(); };
  }, [auth]);

  async function exportNow() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice('');
    const started = epoch.current.value;
    try {
      const expected = informationExportIdentity(current, draftId);
      const before = await auth.getSession();
      const actor = before.data.session?.user.id;
      if (before.error || !actor) throw new Error(EXPORT_CHANGED);
      // The raw tRPC query always goes to the server; no query-cache fallback on failure.
      const fresh = await utils.client.opc.read.query({ draftId });
      const after = await auth.getSession();
      if (after.error || actor !== after.data.session?.user.id || started !== epoch.current.value ||
          latest.current.draftId !== draftId || informationExportIdentity(latest.current.current, draftId) !== expected)
        throw new Error(EXPORT_CHANGED);
      const markdown = confirmedInformationMarkdown(fresh, draftId, expected);
      if (markdown) downloadInformation(markdown);
      setNotice(markdown ? '已下载已确认资料。' : EXPORT_EMPTY);
    } catch (error) {
      setNotice(error instanceof Error && error.message === EXPORT_CHANGED ? EXPORT_CHANGED : EXPORT_FAILED);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <div className="flex flex-wrap items-center gap-2">
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void exportNow()}>
      {busy ? '正在读取…' : '导出已确认资料'}
    </Button>
    {notice && <span role="status" className="text-sm">{notice}</span>}
  </div>;
}
