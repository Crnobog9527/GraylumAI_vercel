import { Link2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ANNOUNCEMENT_LINK_LABEL } from './announcementFormPayload';
import { ANNOUNCEMENT_LINK_ERROR } from '../../../../../../packages/api/src/shared/announcementLink';

export function announcementSaveError(error: unknown): string | null {
  if (!error) return null;
  // Only expose the known validation message, never raw Zod or database details.
  if (error instanceof Error && error.message.includes(ANNOUNCEMENT_LINK_ERROR)) {
    return ANNOUNCEMENT_LINK_ERROR;
  }
  return '公告保存失败，请稍后重试。';
}

export default function AnnouncementLinkField({ value, onChange, error }: {
  value: string;
  onChange: (value: string) => void;
  error: unknown;
}) {
  const message = announcementSaveError(error);
  return (
    <div className="space-y-2">
      <Label htmlFor="announcement-link" style={{ color: 'var(--text-secondary)' }}>
        <span className="flex items-center gap-2">
          <Link2 className="h-4 w-4" />
          {ANNOUNCEMENT_LINK_LABEL}
        </span>
      </Label>
      <Input
        id="announcement-link"
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder="https://example.com 或 /marketplace"
        aria-describedby={message ? 'announcement-save-error' : undefined}
        className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
      />
      {message && <p id="announcement-save-error" role="alert" className="text-sm text-rose-500">{message}</p>}
    </div>
  );
}
