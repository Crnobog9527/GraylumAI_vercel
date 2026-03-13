'use client';

import Link from 'next/link';
import { AlertTriangle, ArrowLeft, Mail, ShieldAlert } from 'lucide-react';
import { resolveSiteName, resolveSupportEmail } from '@/lib/site-config';
import { trpc } from '@/trpc/client';

export default function MaintenancePage() {
  const { data: systemSettings } = trpc.settings.getSystemSettings.useQuery(undefined, {
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

  return (
    <main
      className="min-h-screen px-4 py-6 sm:px-6 lg:px-8"
      style={{
        background:
          'radial-gradient(circle at top left, rgba(255,215,0,0.16), transparent 28%), radial-gradient(circle at bottom right, rgba(239,68,68,0.14), transparent 34%), #070707',
      }}
    >
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-3xl items-center justify-center">
        <section
          className="w-full rounded-[28px] border px-6 py-8 sm:px-8 sm:py-10"
          style={{
            background: 'linear-gradient(160deg, rgba(14,14,14,0.96), rgba(8,8,8,0.92))',
            borderColor: 'rgba(255,255,255,0.08)',
            boxShadow: '0 24px 70px rgba(0,0,0,0.42)',
          }}
        >
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[rgba(248,113,113,0.24)] bg-[rgba(127,29,29,0.2)] px-3 py-1 text-xs uppercase tracking-[0.24em] text-[#fca5a5]">
            <ShieldAlert className="h-3.5 w-3.5" />
            Maintenance Mode
          </div>

          <div className="space-y-4">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-[rgba(255,215,0,0.16)] bg-[rgba(255,215,0,0.1)]">
              <AlertTriangle className="h-7 w-7 text-[#f2c94c]" />
            </div>
            <h1 className="text-3xl font-semibold text-white sm:text-4xl">
              {siteName} 正在维护中
            </h1>
            <p className="max-w-2xl text-sm leading-7 text-[#c7c7c7] sm:text-base">
              当前站点正在进行系统维护或配置切换。普通用户访问已暂时关闭，维护完成后将自动恢复。
            </p>
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] p-5">
              <h2 className="mb-2 text-sm font-medium text-white">当前状态</h2>
              <p className="text-sm leading-6 text-[#b5b5b5]">
                所有业务页面暂时不可用，管理员仍可继续进入后台执行维护操作。
              </p>
            </div>
            <div className="rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] p-5">
              <h2 className="mb-2 text-sm font-medium text-white">需要帮助</h2>
              <p className="flex items-center gap-2 text-sm leading-6 text-[#b5b5b5]">
                <Mail className="h-4 w-4 text-[#f2c94c]" />
                <a href={`mailto:${supportEmail}`} className="text-[#f2c94c] underline-offset-4 hover:underline">
                  {supportEmail}
                </a>
              </p>
            </div>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link
              href="/landing"
              className="inline-flex items-center gap-2 rounded-2xl border border-[rgba(255,255,255,0.08)] px-4 py-3 text-sm text-[#f2f2f2] transition hover:bg-[rgba(255,255,255,0.04)]"
            >
              <ArrowLeft className="h-4 w-4" />
              返回首页
            </Link>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-2xl bg-[#f2c94c] px-4 py-3 text-sm font-medium text-black transition hover:bg-[#f7d96c]"
            >
              重新检查状态
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
