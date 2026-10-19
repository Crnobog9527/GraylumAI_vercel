import { describe, expect, it } from 'vitest';
import { formatTicketNumber, ticketIdRangeFromQuery } from './ticketNumber';

const id = 'b05a4f8d-1111-2222-3333-444444444444';

describe('formatTicketNumber', () => {
  it('uses created_at in UTC so user side and admin agree', () => {
    expect(formatTicketNumber(id, '2026-10-19T23:30:00Z')).toBe('TK-20261019-B05A4F');
    expect(formatTicketNumber(id, new Date('2026-10-20T00:30:00Z'))).toBe('TK-20261020-B05A4F');
  });
});

describe('ticketIdRangeFromQuery', () => {
  it('returns null for empty input', () => {
    expect(ticketIdRangeFromQuery('  ')).toBeNull();
  });
  it('turns the 6-char code, # prefix and TK number into the same uuid range', () => {
    const expected = { kind: 'range', min: 'b05a4f00-0000-0000-0000-000000000000', max: 'b05a4fff-ffff-ffff-ffff-ffffffffffff' };
    expect(ticketIdRangeFromQuery('B05A4F')).toEqual(expected);
    expect(ticketIdRangeFromQuery('#b05a4f')).toEqual(expected);
    expect(ticketIdRangeFromQuery('TK-19990101-B05A4F')).toEqual(expected);
  });
  it('handles uuid prefixes with dashes and full uuids', () => {
    expect(ticketIdRangeFromQuery('b05a4f8d-11')).toEqual({ kind: 'range', min: 'b05a4f8d-1100-0000-0000-000000000000', max: 'b05a4f8d-11ff-ffff-ffff-ffffffffffff' });
    expect(ticketIdRangeFromQuery(id.toUpperCase())).toEqual({ kind: 'eq', id });
  });
  it('matches nothing for non-hex input', () => {
    expect(ticketIdRangeFromQuery('zzz')).toEqual({ kind: 'none' });
    expect(ticketIdRangeFromQuery('TK-20261019-ZZZZZZ')).toEqual({ kind: 'none' });
  });
});
