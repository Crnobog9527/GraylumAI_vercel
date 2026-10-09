/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Synthetic provider/transaction fixtures for router regressions. SQL and the adapter have separate contract tests.
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';

type Row = Record<string, unknown>;
type Result = { data?: Row | null; error?: unknown };
type Query = PromiseLike<Result> & { select: () => Query; eq: (key: string, value: unknown) => Query;
  maybeSingle: () => Promise<Result>; insert: (row: Row) => PromiseLike<Result> };
type Db = { from: (table: string) => Query; rpc?: (name: string, args: Row) => Promise<unknown> };
export function installPurchaseFixture(user: Db, admin: Db, getStripe: () => Stripe) {
  const previousRpc = admin.rpc?.bind(admin);
  const from = admin.from.bind(admin);
  const userFrom = user.from.bind(user);
  const refs: Row[] = [];
  const orders = new Map<string, Row>();
  admin.from = (table: string) => {
    if (table === 'credit_packages' || table === 'membership_plans') return userFrom(table);
    if (table === 'system_settings') return { select() { return this; }, eq() { return this; },
      maybeSingle: async () => ({ data: { value: { channel: 'stripe', version: 1 } } }) } as unknown as Query;
    if (table === 'payment_orders') {
      const query = from(table);
      const originalSelect = query.select;
      const select = (...args: unknown[]) => (originalSelect as (...args: unknown[]) => Query).apply(query, args);
      query.select = ((columns?: string) => {
        if (columns !== 'payment_channel') return select(columns);
        const pending = { eq() { return this; }, is() { return this; }, order() { return this; }, limit() { return this; },
          maybeSingle: async () => ({ data: null, error: null }) };
        return pending as unknown as Query;
      }) as Query['select'];
      return query;
    }
    if (table !== 'payment_provider_refs') return from(table);
    const filters: Array<[string, unknown]> = [];
    const result = async () => {
      const checkoutId = filters.find(([key]) => key === 'external_id')?.[1];
      if (!refs.length && filters.some(([key, value]) => key === 'object_type' && value === 'checkout')) {
        const query = from('payment_orders').select();
        const response = await (typeof query.then === 'function' ? query : query.maybeSingle());
        if (response.error) return { data: [], error: response.error };
        const rows = Array.isArray(response.data) ? response.data : response.data ? [response.data] : [];
        for (const row of rows) {
          row.id ??= randomUUID(); row.price_ref_id = `price-ref-${String(row.id)}`;
          row.payment_channel = 'stripe'; row.merchant_namespace = 'acct_fixture'; row.payment_mode = 'test';
          row.subscription_id = row.stripe_subscription_id ? `sub-ref-${String(row.stripe_subscription_id)}` : null;
          const common = { channel: 'stripe', merchant_namespace: 'acct_fixture', mode: 'test' };
          refs.push({ ...common, id: row.price_ref_id, object_type: 'price', external_id: row.stripe_price_id ?? 'price_original' });
          if (row.stripe_invoice_id) refs.push({ ...common, object_type: 'invoice', order_id: row.id, external_id: row.stripe_invoice_id });
          if (row.subscription_id && !refs.some(ref => ref.subscription_id === row.subscription_id)) {
            refs.push({ ...common, object_type: 'subscription', subscription_id: row.subscription_id, external_id: row.stripe_subscription_id });
          }
        }
        if (rows[0]) refs.push({ channel: 'stripe', merchant_namespace: 'acct_fixture', mode: 'test',
          object_type: 'checkout', order_id: rows[0].id, external_id: checkoutId });
      }
      return { data: refs.filter(row => filters.every(([key, value]) => row[key] === value)), error: null };
    };
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      limit: () => query, maybeSingle: async () => { const selected = await result(); return { ...selected, data: selected.data[0] ?? null }; },
      then: <T>(resolve: (value: Awaited<ReturnType<typeof result>>) => T, reject: (reason: unknown) => T) => result().then(resolve, reject) };
    return query as unknown as Query;
  };
  admin.rpc = async (name, args) => {
    if (name === 'report_membership_check') return previousRpc ? previousRpc(name, args) : { data: null, error: null };
    if (name === 'pay_common_create_purchase') {
      const recurring = args.p_item_type === 'membership_plan';
      const item = (await admin.from(recurring ? 'membership_plans' : 'credit_packages').select().eq('id', args.p_item_id).maybeSingle()).data!;
      if (item[recurring ? 'is_active' : 'active'] !== 'true') return { error: { message: 'PAY_COMMON_PRODUCT_UNAVAILABLE' } };
      const cycle = String(args.p_billing_cycle);
      const priceId = item[recurring ? cycle === 'yearly' ? 'stripe_yearly_price_id' : 'stripe_monthly_price_id' : 'stripe_price_id'];
      const amount = item[recurring ? cycle === 'yearly' ? 'yearly_price' : 'monthly_price' : 'price'];
      if (typeof priceId !== 'string' || !priceId.trim()) return { error: { message: 'PAY_COMMON_PRICE_MAPPING_MISSING' } };
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return { error: { message: 'PAY_COMMON_AMOUNT_INVALID' } };
      const stripe = getStripe();
      const price = { id: priceId, object: 'price', active: true, livemode: false, currency: 'usd', unit_amount: amount,
        billing_scheme: 'per_unit', tax_behavior: 'unspecified', type: recurring ? 'recurring' : 'one_time',
        recurring: recurring ? { interval: cycle === 'yearly' ? 'year' : 'month', interval_count: 1, usage_type: 'licensed' } : null };
      stripe.prices ??= { retrieve: async () => price } as unknown as Stripe['prices'];
      const id = randomUUID();
      const order = { id, user_id: args.p_user_id, item_type: args.p_item_type, item_id: args.p_item_id,
        amount_total: amount, billing_cycle: cycle, status: 'pending', payment_status: 'unpaid', checkout_request: null,
        payment_channel: 'stripe', merchant_namespace: 'acct_fixture', payment_mode: 'test', price_ref_id: `price-ref-${id}`,
        metadata: { productName: item.name, requoteRequired: false }, purchase_snapshot: { version: 1, item_type: args.p_item_type,
          item_id: args.p_item_id, item_updated_at: '2026-10-05T00:00:00.000Z', billing_cycle: cycle,
          currency: 'usd', unit: 'major', price: (amount / 100).toFixed(2), discount: '0.00', tax_behavior: 'unspecified',
          credits: 100, bonus_credits: 0 } };
      const inserted = await from('payment_orders').insert(order);
      if (inserted.error) return inserted;
      refs.push({ id: order.price_ref_id, object_type: 'price', external_id: priceId,
        channel: 'stripe', merchant_namespace: 'acct_fixture', mode: 'test' });
      orders.set(id, order);
      const create = stripe.checkout.sessions.create.bind(stripe.checkout.sessions);
      stripe.checkout.sessions.create = (async (request: Stripe.Checkout.SessionCreateParams, options: Stripe.RequestOptions) => {
        const response = await create(request, options);
        return { ...response, object: 'checkout.session', livemode: false, mode: request.mode,
          metadata: request.metadata, client_reference_id: request.client_reference_id, amount_total: amount, currency: 'usd' };
      }) as Stripe['checkout']['sessions']['create'];
      return { data: structuredClone(order), error: null };
    }
    if (name === 'pay_common_prepare_checkout') return { data: args.p_request, error: null };
    if (name === 'pay_common_record_checkout') return { data: { ok: orders.has(String(args.p_order_id)) }, error: null };
    if (previousRpc) return previousRpc(name, args);
    throw new Error(`Unexpected fixture RPC ${name}`);
  };
}
