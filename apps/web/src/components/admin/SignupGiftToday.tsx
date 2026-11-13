'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useRef } from 'react';
import { trpc } from '@/trpc/client';

/** BOT-GUARD: "今天已送 X / 上限 Y" for the opening grant, counted per Beijing day; refetched after every save. */
export function SignupGiftToday({ refreshKey }: { refreshKey: number }) {
  const today = trpc.admin.getSignupGiftToday.useQuery(undefined, { refetchOnWindowFocus: false });
  const { refetch } = today;
  // A new key after a save reads the count again, so a changed cap shows at once.
  useRefetchOn(refreshKey, refetch);
  if (today.isLoading) return <p className="text-xs mb-3" style={{ color: 'var(--text-tertiary)' }}>正在读取今日注册赠送…</p>;
  if (today.error || !today.data) return <p className="text-xs mb-3" style={{ color: 'var(--warning)' }}>今日注册赠送读取失败</p>;
  return <SignupGiftTodayLine {...today.data} />;
}

export function SignupGiftTodayLine({ day, granted, cap, paused }: { day: string; granted: number; cap: number; paused: boolean }) {
  return (
    <p data-testid="admin-signup-gift-today" className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
      今天（北京时间 {day}）已送 {granted} / 上限 {cap}
      {paused ? '：注册赠送已暂停，新账号一律不送' : cap === 0 ? '：上限为 0，今天新账号一律不送' : ''}
      。没送到的账号以后不会补发。
    </p>
  );
}

function useRefetchOn(key: number, refetch: () => unknown) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    void refetch();
  }, [key, refetch]);
}
