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

export function buildAnnouncementSchedulePayload(
  form: AnnouncementScheduleForm,
  original?: AnnouncementScheduleOriginal | null,
): { startDate?: string; endDate?: string } {
  return {
    startDate: toIsoOrUndefined(form.startDate, original?.start_date),
    endDate: toIsoOrUndefined(form.endDate, original?.end_date),
  };
}
