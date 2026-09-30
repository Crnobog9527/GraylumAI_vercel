// datetime-local inputs hold wall-clock time without a zone. The browser parses such a
// value as local time, so the form must also display stored UTC instants in local time.

export interface AnnouncementScheduleForm {
  startDate: string;
  endDate: string;
}

export interface AnnouncementScheduleOriginal {
  start_date: string | null;
  end_date: string | null;
}

const pad = (value: number) => String(value).padStart(2, '0');

export function toDateTimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toIsoOrUndefined(
  formValue: string,
  originalIso: string | null | undefined,
): string | undefined {
  if (!formValue) return undefined;
  // The input only has minute precision; keep the stored instant when the field is untouched.
  if (originalIso && toDateTimeLocalValue(originalIso) === formValue) return originalIso;
  return new Date(formValue).toISOString();
}

function endDateForPayload(
  formValue: string,
  originalIso: string | null | undefined,
): string | null | undefined {
  // null clears a stored end date on update; create never has an original, so it stays undefined.
  if (!formValue) return originalIso ? null : undefined;
  return toIsoOrUndefined(formValue, originalIso);
}

export function buildAnnouncementSchedulePayload(
  form: AnnouncementScheduleForm,
): { startDate?: string; endDate?: string };
export function buildAnnouncementSchedulePayload(
  form: AnnouncementScheduleForm,
  original: AnnouncementScheduleOriginal,
): { startDate?: string; endDate?: string | null };
export function buildAnnouncementSchedulePayload(
  form: AnnouncementScheduleForm,
  original?: AnnouncementScheduleOriginal,
): { startDate?: string; endDate?: string | null } {
  return {
    startDate: toIsoOrUndefined(form.startDate, original?.start_date),
    endDate: endDateForPayload(form.endDate, original?.end_date),
  };
}

export const START_DATE_REQUIRED = '开始时间必填';

type Schedule = { startDate?: string; endDate?: string };
type UpdateSchedule = { startDate?: string; endDate?: string | null };

// Validates the schedule before any request; returns the message to show, or null once sent.
export function submitAnnouncementSchedule<Base>({ form, editing, base, create, update }: {
  form: AnnouncementScheduleForm;
  editing: (AnnouncementScheduleOriginal & { id: string }) | null;
  base: Base;
  create: (input: Base & Schedule) => void;
  update: (input: Base & UpdateSchedule & { id: string }) => void;
}): string | null {
  if (!form.startDate) return START_DATE_REQUIRED;
  if (editing) {
    update({ ...base, id: editing.id, ...buildAnnouncementSchedulePayload(form, editing) });
  } else {
    create({ ...base, ...buildAnnouncementSchedulePayload(form) });
  }
  return null;
}
