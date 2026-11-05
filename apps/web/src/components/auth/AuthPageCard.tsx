import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AuthCard, AuthHead, AuthLoading, AuthShell } from './AuthShell';

export {
  AUTH_INPUT_CLASS, AUTH_LABEL_CLASS, AUTH_LINK_CLASS, AUTH_PRIMARY_BUTTON_CLASS, AUTH_SECONDARY_BUTTON_CLASS,
} from './AuthShell';

// Single-card layout shared by the password reset pages and the email verification page (look: AuthShell).
export function AuthPageCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <AuthShell>
      <AuthCard>
        <AuthHead icon={<Icon className="h-7 w-7" aria-hidden="true" />} title={title} lead={description} />
        {children}
      </AuthCard>
    </AuthShell>
  );
}

export function AuthPageLoading() {
  return <AuthLoading />;
}
