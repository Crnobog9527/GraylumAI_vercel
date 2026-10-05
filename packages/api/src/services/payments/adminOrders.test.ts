/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listAdminPaymentOrders } from './adminOrders';
it('paginates and projects orders without private identities or raw metadata', async () => {
  const row = { id: 'fixture-order', user_id: 'private-user', merchant_namespace: 'private-merchant',
    metadata: { private: true }, item_type: 'credit_package', payment_channel: 'stripe', payment_mode: 'test',
    status: 'completed', payment_status: 'paid', amount_total: 1200, currency: 'usd' };
  const range = vi.fn().mockResolvedValue({ data: [row], count: 1, error: null });
  const query = { select() { return this; }, order() { return this; }, range };
  const db = { from: () => query } as unknown as Pick<SupabaseClient, 'from'>;
  const docs = { invoiceNumber: null, invoicePdfUrl: null, hostedInvoiceUrl: null, receiptUrl: 'https://pay.stripe.com/example' };
  const result = await listAdminPaymentOrders(db, { offset: 20, limit: 10 }, async () => docs);
  expect(range).toHaveBeenCalledWith(20, 29);
  expect(result.total).toBe(1);
  expect(result.items[0]).toMatchObject({ paymentChannel: 'stripe', documentStatus: 'available', amountMinor: 1200 });
  expect(JSON.stringify(result)).not.toContain('private');
});
