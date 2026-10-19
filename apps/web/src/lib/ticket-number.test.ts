import { describe, expect, it } from 'vitest';
import { formatTicketNumber } from './ticket-number';

const id = 'b05a4f8d-1111-2222-3333-444444444444';

describe('ticket-number', () => {
  it('uses the creation date in UTC, not the viewing date', () => {
    expect(formatTicketNumber(id, '2026-10-19T23:30:00Z')).toBe('TK-20261019-B05A4F');
    expect(formatTicketNumber(id, '2026-10-20T00:30:00Z')).toBe('TK-20261020-B05A4F');
  });
});
