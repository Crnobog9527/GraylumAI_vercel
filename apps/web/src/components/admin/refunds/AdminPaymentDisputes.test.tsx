/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ rows: [] as unknown[], frozen: false, error: false }));
vi.mock('@/trpc/client', () => ({ trpc: {
  useUtils: () => ({ paymentDisputes: { invalidate: vi.fn() }, payments: { invalidate: vi.fn() } }),
  paymentDisputes: {
    list: { useQuery: () => ({ data: fixture.rows, isError: fixture.error, isLoading: false }) },
    notice: { useQuery: () => ({ data: { frozen: fixture.frozen } }) },
    resolveExternal: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    withdraw: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
  },
} }));
import { AdminPaymentDisputes } from './AdminPaymentDisputes';
import { PaymentDisputeNotice } from '@/components/profile/PaymentDisputeNotice';
beforeEach(() => { fixture.rows = []; fixture.frozen = false; fixture.error = false; });
it('shows the approved neutral notice only while the account has a frozen payment', () => {
  expect(renderToStaticMarkup(<PaymentDisputeNotice />)).toBe('');
  fixture.frozen = true;
  expect(renderToStaticMarkup(<PaymentDisputeNotice />))
    .toContain('这笔付款有支付争议，相关会员权益和积分暂停使用，有疑问请联系客服。');
});
it('keeps a won dispute frozen until explicit admin withdrawal and explains stopped renewal', () => {
  fixture.rows = [{ id: 'internal-id', order_id: 'order-id', amount: 100, currency: 'usd', status: 'won',
    freeze_state: 'frozen', renewal_stop_state: 'confirmed', evidence_due_by: null, source_review_required: false }];
  const html = renderToStaticMarkup(<AdminPaymentDisputes />);
  expect(html).toContain('已判赢'); expect(html).toContain('冻结中'); expect(html).toContain('已确认停止');
  expect(html).toContain('撤回冻结'); expect(html).not.toContain('确认撤回冻结</button>');
});
it('does not offer withdrawal for an already superseded refund', () => {
  fixture.rows = [{ id: 'internal-id', order_id: 'order-id', amount: 100, currency: 'usd', status: 'needs_response',
    freeze_state: 'superseded', renewal_stop_state: 'not_applicable', evidence_due_by: null, source_review_required: true }];
  const html = renderToStaticMarkup(<AdminPaymentDisputes />);
  expect(html).toContain('已被退款取代'); expect(html).toContain('积分来源无法核实');
  expect(html).not.toContain('>撤回冻结</button>');
});
it('reports a failed read without presenting it as an empty successful result', () => {
  fixture.error = true;
  expect(renderToStaticMarkup(<AdminPaymentDisputes />)).toContain('拒付记录暂时无法读取');
  expect(renderToStaticMarkup(<AdminPaymentDisputes />)).not.toContain('暂无付款争议');
});

it('offers explicit off-site resolution only for unmatched unresolved records', () => {
  fixture.rows = [{ id: 'unmatched', order_id: null, amount: 100, currency: 'usd', status: 'won',
    freeze_state: 'pending', renewal_stop_state: 'pending' }];
  expect(renderToStaticMarkup(<AdminPaymentDisputes />)).toContain('已核实站外付款');
  fixture.rows = [{ id: 'resolved', order_id: null, amount: 100, currency: 'usd', status: 'won',
    freeze_state: 'external', renewal_stop_state: 'not_applicable' }];
  const html = renderToStaticMarkup(<AdminPaymentDisputes />);
  expect(html).toContain('已确认站外付款');expect(html).not.toContain('>已核实站外付款</button>');
});
