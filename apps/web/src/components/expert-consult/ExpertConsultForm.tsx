/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/trpc/client';
import {
  CONTACT_MAX, CONTACT_MIN, EXPERT_CONSULT_COPY as COPY, NEED_MAX, NEED_MIN, expertConsultErrorText, type ExpertConsultSource,
} from './expertConsultCopy';

function Message({ title, text, action }: { title: string; text: string; action?: { label: string; href: string } }) {
  return (
    <Card data-testid="expert-consult-message">
      <CardHeader><CardTitle>{title}</CardTitle><CardDescription>{text}</CardDescription></CardHeader>
      {action && <CardContent><Button asChild variant="outline"><Link href={action.href}>{action.label}</Link></Button></CardContent>}
    </Card>
  );
}

/** Signed-in booking form. The server decides eligibility and keeps one open request per account. */
export function ExpertConsultForm({ source }: { source: ExpertConsultSource }) {
  const state = trpc.expertConsult.state.useQuery(undefined, { retry: 1, refetchOnWindowFocus: false });
  const send = trpc.expertConsult.request.useMutation();
  const [need, setNeed] = useState('');
  const [contact, setContact] = useState('');
  const tickets = { label: COPY.tickets, href: '/profile?tab=tickets' };

  if (send.data || state.data?.pending) return <Message title={COPY.sentTitle} text={COPY.sentText} action={tickets} />;
  if (state.isLoading) return <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  if (state.error || !state.data) return <Message title={COPY.pageTitle} text={COPY.loadFailed} />;
  if (!state.data.eligible || send.error?.message === 'EXPERT_CONSULT_NOT_ELIGIBLE') {
    return <Message title={COPY.notEligibleTitle} text={COPY.notEligibleText}
      action={{ label: COPY.startPositioning, href: '/positioning' }} />;
  }
  const needLength = need.trim().length, contactLength = contact.trim().length;
  const ready = needLength >= NEED_MIN && needLength <= NEED_MAX && contactLength >= CONTACT_MIN && contactLength <= CONTACT_MAX;
  return (
    <Card>
      <CardHeader><CardTitle>{COPY.pageTitle}</CardTitle><CardDescription>{COPY.pageLede}</CardDescription></CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={event => {
          event.preventDefault();
          if (ready && !send.isPending) send.mutate({ need, contact, source });
        }}>
          <div className="space-y-2">
            <Label htmlFor="expert-consult-need">{COPY.needLabel}</Label>
            <Textarea id="expert-consult-need" rows={6} maxLength={NEED_MAX} value={need} disabled={send.isPending}
              placeholder={COPY.needPlaceholder} onChange={event => setNeed(event.target.value)} />
            <p className="text-xs text-[var(--text-secondary)]">{needLength} / {NEED_MAX}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="expert-consult-contact">{COPY.contactLabel}</Label>
            <Input id="expert-consult-contact" maxLength={CONTACT_MAX} value={contact} disabled={send.isPending}
              placeholder={COPY.contactPlaceholder} onChange={event => setContact(event.target.value)} />
          </div>
          <p className="text-xs text-[var(--text-secondary)]">{COPY.privacy}</p>
          {send.error && <p role="alert" className="text-sm text-[var(--color-error)]">{expertConsultErrorText(send.error.message)}</p>}
          <Button type="submit" disabled={!ready || send.isPending}>{send.isPending ? COPY.submitting : COPY.submit}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
