import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildAnnouncementSchedulePayload,
  toDateTimeLocalValue,
  type AnnouncementScheduleOriginal,
} from './announcementSchedule';

const originalTz = process.env.TZ;

function restoreTimeZone() {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
}

function reopenAndSave(stored: AnnouncementScheduleOriginal): AnnouncementScheduleOriginal {
  const form = {
    startDate: toDateTimeLocalValue(stored.start_date),
    endDate: toDateTimeLocalValue(stored.end_date),
  };
  const payload = buildAnnouncementSchedulePayload(form, stored);
  // Mirrors the update route: undefined keeps the stored value.
  return {
    start_date: payload.startDate ?? stored.start_date,
    end_date: payload.endDate ?? stored.end_date,
  };
}

describe.each(['Asia/Shanghai', 'America/Los_Angeles', 'UTC'])(
  'announcement schedule in %s',
  (timeZone) => {
    beforeEach(() => {
      process.env.TZ = timeZone;
    });

    afterEach(() => {
      restoreTimeZone();
    });

    it('keeps the same instants after repeated open and save', () => {
      const initial: AnnouncementScheduleOriginal = {
        start_date: '2026-09-29T02:00:37.123Z',
        end_date: '2026-10-05T15:45:00+00:00',
      };
      let stored = initial;
      for (let i = 0; i < 5; i += 1) stored = reopenAndSave(stored);

      expect(new Date(stored.start_date!).getTime()).toBe(new Date(initial.start_date!).getTime());
      expect(new Date(stored.end_date!).getTime()).toBe(new Date(initial.end_date!).getTime());
    });

    it('round-trips a minute value entered in the form without an original', () => {
      const payload = buildAnnouncementSchedulePayload({
        startDate: '2026-11-02T09:30',
        endDate: '',
      });

      expect(toDateTimeLocalValue(payload.startDate)).toBe('2026-11-02T09:30');
      expect(payload.endDate).toBeUndefined();
    });

    it('defaults a new announcement to the current local minute', () => {
      const now = new Date();
      const value = toDateTimeLocalValue(now.toISOString());

      expect(Math.abs(new Date(value).getTime() - now.getTime())).toBeLessThan(60_000);
    });
  },
);

describe('announcement schedule in a non-UTC zone', () => {
  beforeEach(() => {
    process.env.TZ = 'Asia/Shanghai';
  });

  afterEach(() => {
    restoreTimeZone();
  });

  it('shows stored UTC instants as local wall-clock time', () => {
    expect(toDateTimeLocalValue('2026-09-29T02:00:00.000Z')).toBe('2026-09-29T10:00');
    expect(toDateTimeLocalValue('2026-09-29T20:15:00+00:00')).toBe('2026-09-30T04:15');
  });

  it('saves edited values as local wall-clock time', () => {
    const payload = buildAnnouncementSchedulePayload(
      { startDate: '2026-10-01T09:30', endDate: '2026-10-02T00:00' },
      { start_date: '2026-09-29T02:00:00.000Z', end_date: null },
    );

    expect(payload).toEqual({
      startDate: '2026-10-01T01:30:00.000Z',
      endDate: '2026-10-01T16:00:00.000Z',
    });
  });

  it('maps empty and invalid stored values to an empty field', () => {
    expect(toDateTimeLocalValue(null)).toBe('');
    expect(toDateTimeLocalValue(undefined)).toBe('');
    expect(toDateTimeLocalValue('not a date')).toBe('');
  });
});
