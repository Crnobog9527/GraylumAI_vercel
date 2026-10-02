/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Calendar } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface FinanceDailyPoint {
  date: string;
  additions: number;
  checkins?: number;
  purchases: number;
  deductions: number;
}

const LEGEND = [['bg-emerald-400', '赠送（含签到）'], ['bg-blue-400', '购买'], ['bg-rose-400', '消耗']] as const;

/** The 赠送 bar matches the overview total: manual additions plus check-in rewards. */
export function FinanceDailyChart({ dailyChart }: { dailyChart: FinanceDailyPoint[] }) {
  const days = dailyChart.map((day) => ({ ...day, given: day.additions + (day.checkins ?? 0) }));
  const maxValue = Math.max(0, ...days.map((d) => Math.max(d.given, d.purchases, d.deductions))) || 1;
  const bar = (value: number) => ({ height: `${(value / maxValue) * 100}%`, minHeight: value > 0 ? '2px' : '0' });
  return (
    <Card data-testid="admin-finance-daily-chart" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <Calendar className="h-5 w-5" />
          近30天积分流动
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <div className="flex items-center gap-4 text-xs mb-4" style={{ color: 'var(--text-tertiary)' }}>
            {LEGEND.map(([color, label]) => (
              <div key={label} className="flex items-center gap-1">
                <div className={`w-3 h-3 ${color} rounded`}></div>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="h-40 flex items-end gap-1">
            {days.slice(-14).map((day) => (
              <div key={day.date} className="flex-1 flex flex-col gap-0.5" title={day.date} data-testid={`admin-finance-day-${day.date}`}>
                <div className="bg-emerald-400 rounded-t" data-given={day.given} style={bar(day.given)} />
                <div className="bg-blue-400" style={bar(day.purchases)} />
                <div className="bg-rose-400 rounded-b" style={bar(day.deductions)} />
              </div>
            ))}
          </div>
          <div className="flex justify-between text-xs" style={{ color: 'var(--text-disabled)' }}>
            <span>{days[days.length - 14]?.date.slice(5) || ''}</span>
            <span>{days[days.length - 1]?.date.slice(5) || ''}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
