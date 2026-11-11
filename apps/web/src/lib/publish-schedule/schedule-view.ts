/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * PUBLISH-SCHEDULE page helpers (docs/launch/tasks/PUBLISH-SCHEDULE.md): the week in the viewer's local time, the
 * times sent to the server (UTC instants), and the fixed texts for each job state. The server decides everything;
 * these only shape what the page shows and sends.
 */
export const MIN_LEAD_MS = 15 * 60_000;
export const MAX_LEAD_MS = 30 * 24 * 3600_000;
export const LOCK_MS = 10 * 60_000;
const DAY_MS = 24 * 3600_000;

export type ScheduleTarget = { connectionId: string; platform: string; status: 'pending' | 'published' | 'failed';
  url?: string | null };
export type ScheduleEntry = {
  id: string; state: 'claimed' | 'dispatching' | 'scheduled' | 'unknown' | 'completed' | 'failed' | 'released';
  at: string; scheduledAt?: string | null; captionPreview?: string | null; cancelReason?: string | null;
  errorCode: string | null; manualReview: boolean; holdCredits: number | null; chargedCredits: number | null;
  targets: ScheduleTarget[];
};

/** Monday 00:00 local time of the week containing `date`, moved by `offsetWeeks`. */
export function weekStart(date: Date, offsetWeeks = 0): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetWeeks * 7);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

/** The seven local days of a week (each a local midnight; a daylight-saving week still has seven days). */
export function weekDays(start: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

/** The [from, to) range of a local week as UTC instants for the server. */
export function weekRange(start: Date): { from: string; to: string } {
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return { from: start.toISOString(), to: end.toISOString() };
}

export const sameLocalDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
  && a.getDate() === b.getDate();

/** Entries of one local day, in time order. */
export function entriesOn(entries: ScheduleEntry[], day: Date): ScheduleEntry[] {
  return entries.filter(entry => sameLocalDay(new Date(entry.at), day))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export const dayLabel = (day: Date) => `${day.getMonth() + 1}月${day.getDate()}日 ${WEEKDAYS[day.getDay()]}`;
const pad = (n: number) => String(n).padStart(2, '0');
export const timeLabel = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const dateTimeLabel = (iso: string) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${timeLabel(iso)}`;
};

/** The viewer's time zone, named the way the page shows it ("太平洋标准时间（America/Los_Angeles）"). */
export function zoneLabel(at: Date = new Date()): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const long = new Intl.DateTimeFormat('zh-CN', { timeZoneName: 'long' }).formatToParts(at)
    .find(part => part.type === 'timeZoneName')?.value;
  return long && zone ? `${long}（${zone}）` : zone || '本机时区';
}

/** The value of an <input type="datetime-local"> for an instant, in local time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value (local time) as a UTC instant, or null when it is not a valid time. */
export function fromLocalInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Why a chosen time cannot be used, or null. Same range the server checks (15 minutes to 30 days ahead). */
export function timeProblem(iso: string | null, now: number): string | null {
  if (!iso) return '请选择日期和时间。';
  const ms = Date.parse(iso);
  if (ms < now + MIN_LEAD_MS) return '最早只能排在 15 分钟以后。';
  if (ms > now + MAX_LEAD_MS) return '最远只能排在 30 天以内。';
  return null;
}

/** A scheduled post can be moved or cancelled until 10 minutes before its time. */
export function changeable(entry: ScheduleEntry, now: number): boolean {
  return entry.state === 'scheduled' && !entry.cancelReason && !!entry.scheduledAt
    && now < Date.parse(entry.scheduledAt) - LOCK_MS;
}

const CANCEL_REASONS: Record<string, string> = {
  PUBLISH_SCHEDULE_CANCELLED: '你已取消',
  PUBLISH_SCHEDULE_MEMBERSHIP_ENDED: '因会员到期已取消',
  PUBLISH_SCHEDULE_TARGET_CHANGED: '账号已断开或撤回了发布授权，已取消',
  PUBLISH_SCHEDULE_ACCOUNT_CLOSED: '账号已注销或停用，已取消',
  PUBLISH_SCHEDULE_PROVIDER_DELETED: '发布服务里的这条帖子已不存在，已取消',
  PUBLISH_SCHEDULE_PROVIDER_CHANGED: '发布服务里的这条帖子被改动过，为安全起见已取消',
};
export const cancelReasonText = (code: string | null | undefined) =>
  (code && CANCEL_REASONS[code]) ?? '这次没有发出';

export type EntryStatus = { label: string; tone: 'waiting' | 'working' | 'done' | 'partial' | 'failed' | 'cancelled';
  detail: string };

/** What the page says about one job (never raw server text). */
export function entryStatus(entry: ScheduleEntry): EntryStatus {
  const failedCount = entry.targets.filter(t => t.status === 'failed').length;
  if (entry.manualReview) {
    return { label: '确认中', tone: 'working', detail: '结果还没确认，已转人工核对。积分暂时冻结，确认没发出会退回；不会重复发。' };
  }
  if (entry.state === 'scheduled' && entry.cancelReason) {
    return { label: '正在取消', tone: 'working', detail: `${cancelReasonText(entry.cancelReason)}。积分会全部退回。` };
  }
  if (entry.state === 'scheduled') {
    return { label: '已排期', tone: 'waiting',
      detail: `约在设定时间发出。暂时冻结 ${entry.holdCredits ?? 0} 积分，只按发布成功的平台扣，其余退回。` };
  }
  if (entry.state === 'claimed' || entry.state === 'dispatching' || entry.state === 'unknown') {
    return { label: '发布中', tone: 'working', detail: '正在等平台结果。只按发布成功的平台扣积分；不会重复发。' };
  }
  if (entry.state === 'completed') {
    if (entry.errorCode === 'PUBLISH_SCHEDULE_SENT_AFTER_CANCEL') {
      return { label: '已发布', tone: 'done', detail: '取消太晚，帖子已经发出；这次没有扣积分。' };
    }
    const charged = `扣除 ${entry.chargedCredits ?? 0} 积分。`;
    return failedCount > 0 ? { label: '部分成功', tone: 'partial', detail: `有 ${failedCount} 个平台没有发成功，只按成功的平台${charged}` }
      : { label: '已发布', tone: 'done', detail: charged };
  }
  if (entry.state === 'failed') return { label: '失败', tone: 'failed', detail: '这次没有发布成功，积分已全部退回。' };
  return { label: '已取消', tone: 'cancelled', detail: `${cancelReasonText(entry.cancelReason ?? entry.errorCode)}，积分已全部退回。` };
}

const MESSAGES: Record<string, string> = {
  PUBLISH_SCHEDULE_TIME_INVALID: '这个时间不能用：最早 15 分钟以后，最远 30 天以内，也不能和原来的时间一样。',
  PUBLISH_SCHEDULE_LOCKED: '离发布不到 10 分钟，已经不能改期或取消了。',
  PUBLISH_SCHEDULE_CHANGED: '这条排期刚刚在别处被改过，页面已刷新，请再看一下。',
  PUBLISH_SCHEDULE_BUSY: '这条排期正在被修改，请稍等几秒再试。',
  PUBLISH_SCHEDULE_CANCELLING: '这条排期正在取消，不能再改期。',
  PUBLISH_SCHEDULE_NOT_SCHEDULED: '这条帖子已经不在排期中了，页面已刷新。',
  PUBLISH_SCHEDULE_PROVIDER_CHANGED: '发布服务里的这条帖子和排期时不一样了，页面已刷新，请再看一下。',
  PUBLISH_MONITOR_QUOTA_EXHAUSTED: '那个时间段的发布名额已满，请换一个时间。',
  PUBLISH_MONITOR_ENTITLEMENT_REQUIRED: '改期需要 Pro 或 Gold 会员；取消不受影响。',
  PUBLISH_MONITOR_DISABLED: '发布功能暂时关闭，暂时不能改期；取消不受影响。',
  PUBLISH_MONITOR_JOB_NOT_FOUND: '找不到这条排期。',
};
export function scheduleErrorMessage(code: string | null | undefined, httpCode?: string): string {
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (httpCode === 'TOO_MANY_REQUESTS') return '操作太频繁或发布通道繁忙，请稍后再试。';
  return '暂时没有完成，请稍后重试。';
}

/** Whether the list should be re-read soon (something on it is waiting for a result or a cancellation). */
export const hasOpenEntries = (entries: ScheduleEntry[], now: number) => entries.some(entry =>
  entry.state === 'dispatching' || entry.state === 'unknown' || (entry.state === 'scheduled'
    && (!!entry.cancelReason || (!!entry.scheduledAt && Date.parse(entry.scheduledAt) - now < DAY_MS))));
