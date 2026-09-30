import Link from 'next/link';
import { CheckCircle2, Mail } from 'lucide-react';

export interface AuthStatus {
  tone: 'error' | 'success' | 'info';
  message: string;
  // Adds the fixed "resend verification" entry after a failed email sign-in.
  offerResend?: boolean;
}

const TONES = {
  error: { borderColor: 'rgba(248,113,113,0.24)', background: 'rgba(127,29,29,0.2)', color: '#fecaca' },
  success: { borderColor: 'rgba(74,222,128,0.24)', background: 'rgba(20,83,45,0.2)', color: '#bbf7d0' },
  info: { borderColor: 'rgba(255,215,0,0.24)', background: 'rgba(120,53,15,0.2)', color: '#fde68a' },
} as const;

export function AuthStatusBanner({ status, resendHref }: { status: AuthStatus; resendHref: string }) {
  const Icon = status.tone === 'success' ? CheckCircle2 : Mail;
  return (
    <div className="rounded-2xl border px-4 py-3 text-sm leading-6" aria-live="polite" style={TONES[status.tone]}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {status.message}
          {status.offerResend && (
            <Link href={resendHref} className="ml-1 text-[#f2c94c] underline underline-offset-4">
              还没验证邮箱？重新发送验证邮件
            </Link>
          )}
        </span>
      </div>
    </div>
  );
}
