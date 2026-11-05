'use client';

import { useState } from 'react';
import { AlertTriangle, ArrowLeft, Mail, ShieldAlert } from 'lucide-react';
import { sanitizeRedirectTarget } from '@/lib/auth';
import { resolveSiteName, resolveSupportEmail } from '@/lib/site-config';
import { trpc } from '@/trpc/client';
import { AUTH_LINK_CLASS, AUTH_PRIMARY_BUTTON_CLASS, AUTH_SECONDARY_BUTTON_CLASS, AuthCard, AuthHead, AuthPanel, AuthShell } from '@/components/auth/AuthShell';

function isMaintenanceModeEnabled(value: unknown) {
  return value === true || value === 'true';
}

function resolveMaintenanceReturnTarget() {
  if (typeof window === 'undefined') {
    return '/app/profile';
  }

  const searchParams = new URLSearchParams(window.location.search);
  return sanitizeRedirectTarget(searchParams.get('from'));
}

export default function MaintenancePage() {
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(false);
  const { data: systemSettings, refetch } = trpc.settings.getSystemSettings.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const siteName =
    typeof systemSettings?.site_name === 'string' && systemSettings.site_name.trim()
      ? systemSettings.site_name.trim()
      : resolveSiteName();
  const supportEmail =
    typeof systemSettings?.support_email === 'string' && systemSettings.support_email.trim()
      ? systemSettings.support_email.trim()
      : resolveSupportEmail();
  const maintenanceModeEnabled = isMaintenanceModeEnabled(systemSettings?.maintenance_mode);

  const handleReturnHome = () => {
    // The public home page is the root of this same host (single host, SEO_GEO_SPEC section 2).
    window.location.assign('/');
  };

  const handleRefreshStatus = async () => {
    setIsCheckingStatus(true);
    setStatusMessage(null);

    try {
      const latestSettings = await refetch();
      const latestMaintenanceModeEnabled = isMaintenanceModeEnabled(latestSettings.data?.maintenance_mode);

      if (latestMaintenanceModeEnabled) {
        setStatusMessage('维护仍在进行中，请稍后再试。');
        return;
      }

      window.location.assign(resolveMaintenanceReturnTarget());
    } catch {
      setStatusMessage('状态检查失败，请稍后重试。');
    } finally {
      setIsCheckingStatus(false);
    }
  };

  return (
    <AuthShell siteName={siteName}>
      <AuthCard>
        <AuthHead
          icon={<AlertTriangle className="h-7 w-7" aria-hidden="true" />}
          title={`${siteName} 正在维护中`}
          lead="当前站点正在进行系统维护或配置切换。普通用户访问已暂时关闭，维护完成后将自动恢复。"
        />

        <div className="grid gap-3">
          <AuthPanel>
            <h2 className="mb-1 flex items-center gap-2 text-sm font-medium text-[var(--pub-ink)]">
              <ShieldAlert className="h-4 w-4" aria-hidden="true" />
              当前状态
            </h2>
            <p>所有业务页面暂时不可用，管理员仍可继续进入后台执行维护操作。</p>
          </AuthPanel>
          <AuthPanel>
            <h2 className="mb-1 text-sm font-medium text-[var(--pub-ink)]">需要帮助</h2>
            <p className="flex items-center gap-2">
              <Mail className="h-4 w-4" aria-hidden="true" />
              <a href={`mailto:${supportEmail}`} className={AUTH_LINK_CLASS}>
                {supportEmail}
              </a>
            </p>
          </AuthPanel>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={handleReturnHome} className={`${AUTH_SECONDARY_BUTTON_CLASS} inline-flex items-center gap-2 border`}>
            <ArrowLeft className="h-4 w-4" />
            返回首页
          </button>
          <button
            type="button"
            onClick={handleRefreshStatus}
            disabled={isCheckingStatus}
            className={`${AUTH_PRIMARY_BUTTON_CLASS} inline-flex w-auto items-center justify-center`}
          >
            {isCheckingStatus ? '检查中...' : '重新检查状态'}
          </button>
        </div>

        {(statusMessage || !maintenanceModeEnabled) ? (
          <p className="text-sm text-[var(--pub-muted)]">
            {statusMessage ?? '维护已结束，正在为您恢复访问。'}
          </p>
        ) : null}
      </AuthCard>
    </AuthShell>
  );
}
