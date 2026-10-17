/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminProcedure, router } from '../trpc';
import { listPaymentNotices, paymentNoticeResendSchema, resendPaymentNotice } from '../services/notify/admin';
import { PAYMENT_NOTICE_TEMPLATES } from '../services/notify/registry';

/** PAY-NOTIFY: payment notices that need a person, and the same-idempotency-key resend button. */
export const paymentNoticesRouter = router({
  list: adminProcedure.query(({ ctx }) => listPaymentNotices(ctx.supabase, ctx.user.id)),
  resend: adminProcedure.input(paymentNoticeResendSchema).mutation(async ({ ctx, input }) => {
    const result = await resendPaymentNotice(ctx.supabase, ctx.user.id, input.id, { templates: PAYMENT_NOTICE_TEMPLATES });
    return { outcome: result.outcome, code: result.code ?? null };
  }),
});
