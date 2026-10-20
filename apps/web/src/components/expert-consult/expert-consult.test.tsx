/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpertConsultCard } from './ExpertConsultCard';
import { ExpertConsultForm } from './ExpertConsultForm';
import { EXPERT_CONSULT_COPY as COPY, expertConsultErrorText, expertConsultPath, isExpertConsultSource } from './expertConsultCopy';

const hooks = vi.hoisted(() => ({
  state: { isLoading: false, error: null as null | { message: string }, data: undefined as unknown },
  send: { isPending: false, error: null as null | { message: string }, data: undefined as unknown, mutate: () => {} },
}));
vi.mock('@/trpc/client', () => ({ trpc: { expertConsult: {
  state: { useQuery: () => hooks.state }, request: { useMutation: () => hooks.send },
} } }));

const render = () => renderToStaticMarkup(createElement(ExpertConsultForm, { source: 'report' }));
beforeEach(() => {
  hooks.state = { isLoading: false, error: null, data: { eligible: true, pending: null } };
  hooks.send = { isPending: false, error: null, data: undefined, mutate: () => {} };
});

describe('expert consult entry card', () => {
  it('says "预约咨询，免费询价", links to the booking page and never shows a price', () => {
    const html = renderToStaticMarkup(createElement(ExpertConsultCard, { href: expertConsultPath('pricing') }));
    expect(html).toContain('预约咨询，免费询价');
    expect(html).toContain('href="/app/expert-consult?from=pricing"');
    expect(html).not.toMatch(/\$|美元|\d+\s*元|每小时|\/小时/);
  });

  it('accepts only the three entry places', () => {
    expect(['report', 'pricing', 'studio'].every(isExpertConsultSource)).toBe(true);
    expect([null, '', 'checkout', 'REPORT'].some(isExpertConsultSource)).toBe(false);
  });
});

describe('expert consult booking form', () => {
  it('shows the need and contact fields to an eligible account, with no consent switch or price', () => {
    const html = render();
    expect(html).toContain(COPY.needLabel);
    expect(html).toContain(COPY.contactLabel);
    expect(html).toContain(COPY.privacy);
    expect(html).not.toMatch(/type="checkbox"|同意专家查看|\$|每小时/);
  });

  it('tells an account without a confirmed positioning to finish one first', () => {
    hooks.state.data = { eligible: false, pending: null };
    const html = render();
    expect(html).toContain(COPY.notEligibleTitle);
    expect(html).toContain('href="/app/positioning"');
    expect(html).not.toContain(COPY.needLabel);
  });

  it('shows the received message instead of a second form when a request is pending or just sent', () => {
    hooks.state.data = { eligible: true, pending: { ticketId: 'x', createdAt: '2026-10-17T00:00:00Z' } };
    expect(render()).toContain(COPY.sentTitle);
    hooks.state.data = { eligible: true, pending: null };
    hooks.send.data = { ticketId: 'x', createdAt: '2026-10-17T00:00:00Z', created: true };
    const html = render();
    expect(html).toContain(COPY.sentTitle);
    expect(html).toContain('href="/app/profile?tab=tickets"');
  });

  it('maps only known server codes and never shows raw errors', () => {
    expect(expertConsultErrorText('EXPERT_CONSULT_NOT_ELIGIBLE')).toBe(COPY.notEligibleTitle);
    expect(expertConsultErrorText('relation "tickets" does not exist')).toBe('提交没有成功，请稍后再试。');
    hooks.send.error = { message: 'duplicate key value violates constraint' };
    expect(render()).not.toContain('duplicate key');
  });

  it('a failed state read shows a generic message', () => {
    hooks.state = { isLoading: false, error: { message: 'EXPERT_CONSULT_UNAVAILABLE' }, data: undefined };
    expect(render()).toContain(COPY.loadFailed);
  });
});
