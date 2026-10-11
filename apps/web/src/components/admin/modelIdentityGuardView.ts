/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Pure helpers for the MODEL-IDENTITY-GUARD admin switch.

type ErrorLike = { data?: { code?: string } | null } | null | undefined;

export function modelIdentityGuardError(error: ErrorLike, action: 'read' | 'save') {
  const code = error?.data?.code;
  if (action === 'save' && code === 'CONFLICT') return '设置已被其他人修改，已重新读取，请确认当前状态后再操作。';
  if (code === 'FORBIDDEN') return '当前账号无权修改这个设置。';
  return action === 'read' ? '暂时无法读取模型身份保护设置，请稍后重试。' : '保存失败，请重新读取后再试。';
}

/** Shown in the admin's local time; the server stores UTC. */
export function formatChangeTime(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function stateLabel(enabled: boolean) {
  return enabled ? '已开启' : '已关闭';
}
