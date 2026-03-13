import { describe, expect, it } from 'vitest';
import {
  hasRoutingEvidence,
  matchBillingSettleByRequestId,
  matchBillingSettleForUsage,
} from '../diagnostics';

describe('diagnostics helpers', () => {
  it('matches settle rows by metadata requestId', () => {
    const matched = matchBillingSettleByRequestId([
      {
        id: 'settle-1',
        metadata: {
          requestId: 'req-123',
          actualCredits: 1,
        },
      },
      {
        id: 'settle-2',
        metadata: {
          requestId: 'req-456',
          actualCredits: 2,
        },
      },
    ], 'req-456');

    expect(matched?.id).toBe('settle-2');
  });

  it('accepts routingReason as valid routing evidence', () => {
    expect(hasRoutingEvidence({}, { routingReason: '智能路由: 复杂任务使用 Sonnet' })).toBe(true);
    expect(hasRoutingEvidence({}, {})).toBe(false);
  });

  it('falls back to conversation and closest timestamp when legacy settle rows miss requestId', () => {
    const matched = matchBillingSettleForUsage([
      {
        id: 'settle-older',
        created_at: '2026-03-09T06:10:00.000Z',
        metadata: {
          response: {
            conversationId: 'conv-123',
          },
        },
      },
      {
        id: 'settle-closest',
        created_at: '2026-03-09T06:10:54.491Z',
        metadata: {
          response: {
            conversationId: 'conv-123',
          },
        },
      },
    ], {
      conversation_id: 'conv-123',
      request_id: 'req-missing-from-legacy-settle',
      created_at: '2026-03-09T06:10:54.622Z',
    });

    expect(matched?.id).toBe('settle-closest');
  });
});
