import { describe, expect, it } from 'vitest';
import { formatTicketNumber, ticketMatchesQuery } from './ticket-number';

const id = 'b05a4f8d-1111-2222-3333-444444444444';

describe('ticket-number', () => {
  it('formats like the user-side number', () => {
    expect(formatTicketNumber(id, new Date(Date.UTC(2026, 9, 19, 23, 0)))).toBe('TK-20261019-B05A4F');
  });
  it('matches TK number regardless of date segment', () => {
    expect(ticketMatchesQuery(id, 'TK-20261019-B05A4F')).toBe(true);
    expect(ticketMatchesQuery(id, 'tk-20250101-b05a4f')).toBe(true);
    expect(ticketMatchesQuery(id, 'TK-20261019-AAAAAA')).toBe(false);
  });
  it('matches short code, hash prefix and full uuid; empty matches all', () => {
    expect(ticketMatchesQuery(id, 'b05a4f')).toBe(true);
    expect(ticketMatchesQuery(id, '#B05A4F8D')).toBe(true);
    expect(ticketMatchesQuery(id, id)).toBe(true);
    expect(ticketMatchesQuery(id, '  ')).toBe(true);
    expect(ticketMatchesQuery(id, 'zzz')).toBe(false);
  });
});
