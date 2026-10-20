import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AnnouncementScheduleForm } from './announcementSchedule';

const inputClass = 'bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]';

export default function AnnouncementScheduleFields({ value, onChange, startError }: {
  value: AnnouncementScheduleForm;
  onChange: (value: Partial<AnnouncementScheduleForm>) => void;
  startError: string | null;
}) {
  // Hide the required hint as soon as a start time is entered again.
  const message = value.startDate ? null : startError;
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">
        <Label htmlFor="announcement-start" style={{ color: 'var(--text-secondary)' }}>开始时间</Label>
        <Input
          id="announcement-start"
          type="datetime-local"
          required
          value={value.startDate}
          onChange={(e) => onChange({ startDate: e.target.value })}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? 'announcement-start-error' : undefined}
          className={inputClass}
        />
        {message && <p id="announcement-start-error" role="alert" className="text-sm text-rose-500">{message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="announcement-end" style={{ color: 'var(--text-secondary)' }}>结束时间 (可选)</Label>
        <Input
          id="announcement-end"
          type="datetime-local"
          value={value.endDate}
          onChange={(e) => onChange({ endDate: e.target.value })}
          className={inputClass}
        />
      </div>
    </div>
  );
}
