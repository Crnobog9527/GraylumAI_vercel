/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The admin API marks login fields it cannot read as unrecorded; never show those as "never logged in".
export function formatLastLogin(profile: { last_login_at: string | null; login_record_status?: 'unrecorded' }) {
  if (profile.last_login_at) return new Date(profile.last_login_at).toLocaleString('zh-CN');
  return profile.login_record_status === 'unrecorded' ? '未记录' : '从未登录';
}
