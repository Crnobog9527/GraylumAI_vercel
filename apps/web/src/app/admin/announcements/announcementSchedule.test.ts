import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildAnnouncementSchedulePayload,
  START_DATE_REQUIRED,
  submitAnnouncementSchedule,
  toDateTimeLocalValue,
  type AnnouncementScheduleForm,
  type AnnouncementScheduleOriginal,
} from './announcementSchedule';

const originalTz = process.env.TZ;

function restoreTimeZone() {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
}

function reopenAndSave(
  stored: AnnouncementScheduleOriginal,
  edits: Partial<AnnouncementScheduleForm> = {},
): AnnouncementScheduleOriginal {
  const form = {
    startDate: toDateTimeLocalValue(stored.start_date),
    endDate: toDateTimeLocalValue(stored.end_date),
    ...edits,
  };
  const payload = buildAnnouncementSchedulePayload(form, stored);
  // Mirrors the update route: undefined keeps the stored value, null clears it.
  return {
    start_date: payload.startDate ?? stored.start_date,
    end_date: payload.endDate === undefined ? stored.end_date : payload.endDate,
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

describe('announcement end date clearing', () => {
  beforeEach(() => {
    process.env.TZ = 'Asia/Shanghai';
  });

  afterEach(() => {
    restoreTimeZone();
  });

  const stored: AnnouncementScheduleOriginal = {
    start_date: '2026-09-29T02:00:00+00:00',
    end_date: '2026-10-05T15:45:00+00:00',
  };

  it('sends null when an existing end date is cleared', () => {
    const payload = buildAnnouncementSchedulePayload(
      { startDate: toDateTimeLocalValue(stored.start_date), endDate: '' },
      stored,
    );

    expect(payload).toEqual({ startDate: stored.start_date, endDate: null });
  });

  it('omits the end date when it was already empty', () => {
    const payload = buildAnnouncementSchedulePayload(
      { startDate: toDateTimeLocalValue(stored.start_date), endDate: '' },
      { ...stored, end_date: null },
    );

    expect(payload.endDate).toBeUndefined();
  });

  it('keeps an untouched end date instant', () => {
    const payload = buildAnnouncementSchedulePayload(
      { startDate: toDateTimeLocalValue(stored.start_date), endDate: toDateTimeLocalValue(stored.end_date) },
      stored,
    );

    expect(payload.endDate).toBe(stored.end_date);
  });

  it('omits an empty end date when creating', () => {
    expect(buildAnnouncementSchedulePayload({ startDate: '2026-10-01T09:30', endDate: '' }).endDate)
      .toBeUndefined();
  });

  it('stays cleared after reopening and saving again', () => {
    const cleared = reopenAndSave(stored, { endDate: '' });

    expect(cleared.end_date).toBeNull();
    expect(reopenAndSave(cleared)).toEqual(cleared);
  });
});

describe('announcement schedule submit guard', () => {
  const editing = {
    id: 'announcement-1',
    start_date: '2026-09-29T02:00:00+00:00',
    end_date: '2026-10-05T15:45:00+00:00',
  };

  function submit(form: AnnouncementScheduleForm, original: typeof editing | null) {
    const create = vi.fn();
    const update = vi.fn();
    const error = submitAnnouncementSchedule({ form, editing: original, base: { title: 't' }, create, update });
    return { error, create, update };
  }

  it('does not send a request when the start time is cleared while editing', () => {
    const { error, create, update } = submit({ startDate: '', endDate: '' }, editing);

    expect(error).toBe(START_DATE_REQUIRED);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('does not send a request when the start time is empty while creating', () => {
    const { error, create, update } = submit({ startDate: '', endDate: '2026-10-02T18:45' }, null);

    expect(error).toBe(START_DATE_REQUIRED);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('updates with a cleared end date as null', () => {
    const form = { startDate: toDateTimeLocalValue(editing.start_date), endDate: '' };
    const { error, update } = submit(form, editing);

    expect(error).toBeNull();
    expect(update).toHaveBeenCalledWith({
      title: 't', id: editing.id, startDate: editing.start_date, endDate: null,
    });
  });

  it('creates without an end date field when it is empty', () => {
    const { error, create, update } = submit({ startDate: '2026-10-01T09:30', endDate: '' }, null);

    expect(error).toBeNull();
    expect(update).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].endDate).toBeUndefined();
  });
});
