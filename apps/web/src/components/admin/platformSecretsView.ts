/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Pure helpers for the ADMIN-SECRETS page (write-only third-party keys).

export type PlatformSecretSlot = 'openrouter' | 'postforme' | 'postforme_webhook' | 'tikhub' | 'parallel' | 'firecrawl'
  | 'resend';
export interface PlatformSecretItem {
  slot: PlatformSecretSlot;
  configured: boolean;
  last4: string | null;
  revision: number;
  updatedAt: string | null;
  updatedByEmail: string | null;
  envFallback: { name: string; present: boolean; last4: string | null } | null;
  source: 'admin' | 'env' | 'none';
}

export const SLOT_INFO: Record<PlatformSecretSlot, { name: string; usage: string; hint: string }> = {
  openrouter: { name: 'OpenRouter', usage: '所有 AI 模型调用', hint: '以 sk-or- 开头' },
  postforme: { name: 'Post for Me', usage: '一键发布和作品数据', hint: '以 pfm_live_ 或 pfm_test_ 开头' },
  postforme_webhook: { name: 'Post for Me Webhook 共享密钥', usage: '校验 Post for Me 发来的发布结果和账号变化通知',
    hint: '至少 16 个字符，和 Post for Me 后台填写的一致' },
  tikhub: { name: 'TikHub', usage: '社媒平台公开数据搜索', hint: '' },
  parallel: { name: 'Parallel', usage: '网页搜索', hint: '' },
  firecrawl: { name: 'Firecrawl', usage: '网页正文读取', hint: '' },
  resend: { name: 'Resend', usage: '付款相关提醒邮件（续费、到期等）', hint: '以 re_ 开头' },
};

type ErrorLike = { data?: { code?: string } | null; message?: string } | null | undefined;

export function platformSecretError(error: ErrorLike, action: 'read' | 'save' | 'clear') {
  const code = error?.data?.code;
  if (code === 'CONFLICT') return '这把密钥刚被其他管理员修改过，已重新读取，请确认后再操作。';
  if (code === 'FORBIDDEN') return '当前账号无权修改密钥。';
  if (code === 'BAD_REQUEST') return '密钥格式不正确，请检查是否完整复制（不能有空格）。';
  if (error?.message === 'PLATFORM_SECRET_VAULT_MISSING') return '数据库的加密存储没有开启，暂时不能保存，请联系技术处理。';
  if (action === 'read') return '暂时无法读取密钥状态，请稍后重试。';
  return action === 'save' ? '保存失败，请重新读取后再试。' : '清除失败，请重新读取后再试。';
}

/** What the system uses right now, in plain words. */
export function sourceLabel(item: PlatformSecretItem) {
  if (item.source === 'admin') return `正在使用后台填写的密钥（末 4 位 ${item.last4}）`;
  if (item.source === 'env' && item.envFallback) {
    return `后台未填写，正在使用 Vercel 环境变量 ${item.envFallback.name}（末 4 位 ${item.envFallback.last4}），建议在这里填写`;
  }
  return '未配置，相关功能会提示"未配置"';
}

export function clearWarning(item: PlatformSecretItem) {
  if (item.envFallback?.present) {
    return `清除后会改用 Vercel 环境变量 ${item.envFallback.name}（末 4 位 ${item.envFallback.last4}）。`;
  }
  return '清除后没有可用的密钥，相关功能会停止并提示"未配置"。';
}

export const REPLACE_NOTE: Partial<Record<PlatformSecretSlot, string>> = {
  openrouter: '更换 OpenRouter 密钥后，staging 测试窗口要同步更新，用旧密钥发起、还没对账的调用将无法再查账。',
};
