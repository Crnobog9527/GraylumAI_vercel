/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { trpc } from '@/trpc/client';

const RANGES = [7, 30, 90] as const;
const LABELS: Record<string, string> = {
  unknown: '未知（未同意统计或注册早于记录）', direct: '直接访问', other: '其他（未登记的推广参数）',
};

/**
 * Sign-ups and paying accounts per first source (ANALYTICS plan §3.2). Aggregates from the database only; the source
 * is the registered utm_source, else the referrer host name. The database is authoritative for these numbers.
 */
export function SignupSourcesCard() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const report = trpc.analytics.signupSources.useQuery({ days }, { staleTime: 60_000 });
  const rows = report.data ?? [];
  return (
    <Card className="mb-8" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle className="text-base" style={{ color: 'var(--text-primary)' }}>注册来源（首次来源）</CardTitle>
        <div className="flex gap-2" role="group" aria-label="时间范围">
          {RANGES.map(range => (
            <button key={range} type="button" onClick={() => setDays(range)} aria-pressed={days === range}
              className="rounded-md px-2 py-1 text-xs"
              style={{ background: days === range ? 'var(--bg-tertiary)' : 'transparent', color: 'var(--text-secondary)' }}>
              近 {range} 天
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {report.isLoading ? <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>正在读取…</p>
          : report.isError ? <p role="alert" className="text-sm" style={{ color: 'var(--error)' }}>暂时读不到注册来源，请稍后再试。</p>
            : rows.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>这段时间没有新注册。</p>
              : (
                <table className="w-full text-sm" style={{ color: 'var(--text-secondary)' }}>
                  <thead>
                    <tr className="text-left text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      <th className="py-1 font-normal">来源</th><th className="py-1 font-normal">注册数</th><th className="py-1 font-normal">付费数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => (
                      <tr key={row.source}>
                        <td className="py-1">{LABELS[row.source] ?? row.source}</td><td className="py-1">{row.signups}</td>
                        <td className="py-1">{row.paid}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
      </CardContent>
    </Card>
  );
}
