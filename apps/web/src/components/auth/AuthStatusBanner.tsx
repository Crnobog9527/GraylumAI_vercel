import Link from 'next/link';
import { CheckCircle2, Mail } from 'lucide-react';

export interface AuthStatus {
  tone: 'error' | 'success' | 'info';
  message: string;
  // Adds the fixed "resend verification" entry after a failed email sign-in.
  offerResend?: boolean;
}

// Error and success use the light foundation's state colors (DESIGN.md: --gl-error / --gl-success notices).
const TONES = {
  error: { borderColor: 'var(--gl-error)', background: 'var(--gl-error-bg)', color: 'var(--gl-error)' },
  success: { borderColor: 'var(--gl-success)', background: 'var(--gl-success-bg)', color: 'var(--gl-success)' },
  info: { borderColor: 'var(--gl-warning)', background: 'var(--gl-warning-bg)', color: 'var(--gl-warning)' },
} as const;

// onResendClick lets the page save the email it shows before the link opens /verify-email.
export function AuthStatusBanner({ status, resendHref, onResendClick }: {
  status: AuthStatus;
  resendHref?: string;
  onResendClick?: () => void;
}) {
  const Icon = status.tone === 'success' ? CheckCircle2 : Mail;
  return (
    <div className="rounded-xl border px-4 py-3 text-sm leading-6" aria-live="polite" style={TONES[status.tone]}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {status.message}
          {status.offerResend && resendHref && (
            <Link href={resendHref} onClick={onResendClick} className="ml-1 text-[var(--pub-ink)] underline underline-offset-4">
              还没验证邮箱？重新发送验证邮件
            </Link>
          )}
        </span>
      </div>
    </div>
  );
}
