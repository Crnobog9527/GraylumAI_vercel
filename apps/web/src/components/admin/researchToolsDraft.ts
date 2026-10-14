/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Pure helpers for the RESEARCH-TOOLS admin panel (RT-2b). The server (researchTools.set, migration
// 0254) is the authority: it re-checks admin rights, the revision and the hard-cap rule.

export const RESEARCH_VENDORS = ['tikhub', 'parallel', 'firecrawl'] as const;
export type ResearchVendor = typeof RESEARCH_VENDORS[number];

export const VENDOR_LABELS: Record<ResearchVendor, { name: string; use: string }> = {
  tikhub: { name: 'TikHub', use: '社媒数据（账号、作品、关键词）' },
  parallel: { name: 'Parallel', use: '网页搜索' },
  firecrawl: { name: 'Firecrawl', use: '网页抓取' },
};

type Attestation = { by: string; at: string } | null;
export interface ResearchToolsView {
  config: {
    version: 1;
    enabled: boolean;
    vendors: Record<ResearchVendor, { enabled: boolean; hardCapAttested: Attestation }>;
    verifiedPlatforms: unknown;
    benchmarkPlatforms: unknown;
    routes: unknown;
    limits: unknown;
    recentGrowth: unknown;
  };
  source: 'configured' | 'default' | 'invalid';
  revision: number;
  updatedAt: string | null;
  updatedByEmail: string | null;
  hardCapAttestedBy: Record<string, string | null>;
  historyAvailable: boolean;
  history: Array<{ revision: number | null; enabled: boolean; hardCapAttested: unknown[]; operatorEmail: string | null; at: string }>;
}

export interface ResearchToolsDraft {
  enabled: boolean;
  vendors: Record<ResearchVendor, { enabled: boolean; attest: boolean }>;
  /** Routes, platforms, limits and growth thresholds, edited as JSON; validated by the server. */
  advanced: string;
}

export function toDraft(view: ResearchToolsView): ResearchToolsDraft {
  const { verifiedPlatforms, benchmarkPlatforms, routes, limits, recentGrowth } = view.config;
  return {
    enabled: view.config.enabled,
    vendors: Object.fromEntries(RESEARCH_VENDORS.map(v => [v, { enabled: view.config.vendors[v].enabled, attest: false }])) as
      ResearchToolsDraft['vendors'],
    advanced: JSON.stringify({ verifiedPlatforms, benchmarkPlatforms, routes, limits, recentGrowth }, null, 2),
  };
}

export function isAttested(view: ResearchToolsView, vendor: ResearchVendor) {
  return view.config.vendors[vendor].hardCapAttested !== null;
}

/**
 * Why a supplier switch cannot be turned on, or null when it can. A supplier can only be enabled after
 * its platform hard cap is registered (Owner 2026-10-07): already on record, or confirmed in this save.
 */
export function enableBlockedReason(view: ResearchToolsView, draft: ResearchToolsDraft, vendor: ResearchVendor): string | null {
  if (isAttested(view, vendor) || draft.vendors[vendor].attest) return null;
  return `还没有登记平台硬上限：请先在 ${VENDOR_LABELS[vendor].name} 后台设好预付余额或消费上限，再勾选下面的确认，才能打开。`;
}

export type BuildResult =
  | { ok: true; input: { config: Record<string, unknown>; attestHardCap: ResearchVendor[]; expectedRevision: number } }
  | { ok: false; error: string };

export function buildInput(view: ResearchToolsView, draft: ResearchToolsDraft): BuildResult {
  let advanced: unknown;
  try { advanced = JSON.parse(draft.advanced); } catch { return { ok: false, error: '高级设置不是有效的 JSON，请检查后再保存。' }; }
  if (!advanced || typeof advanced !== 'object' || Array.isArray(advanced)) {
    return { ok: false, error: '高级设置必须是一个 JSON 对象。' };
  }
  for (const vendor of RESEARCH_VENDORS) {
    if (draft.vendors[vendor].enabled && enableBlockedReason(view, draft, vendor)) {
      return { ok: false, error: `${VENDOR_LABELS[vendor].name} 还没有登记平台硬上限，不能打开。` };
    }
  }
  const { verifiedPlatforms, benchmarkPlatforms, routes, limits, recentGrowth } = advanced as Record<string, unknown>;
  return { ok: true, input: {
    config: {
      version: 1, enabled: draft.enabled,
      vendors: Object.fromEntries(RESEARCH_VENDORS.map(v => [v, { enabled: draft.vendors[v].enabled }])),
      verifiedPlatforms, benchmarkPlatforms, routes, limits, recentGrowth,
    },
    attestHardCap: RESEARCH_VENDORS.filter(v => draft.vendors[v].attest),
    expectedRevision: view.revision,
  } };
}

type ErrorLike = { data?: { code?: string } | null; message?: string } | null | undefined;

export function researchToolsError(error: ErrorLike, action: 'read' | 'save') {
  const code = error?.data?.code;
  if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') return '当前账号无权查看或修改联网搜索设置。';
  if (action === 'save' && code === 'CONFLICT') return '设置已被其他人修改，已重新读取，请确认后再保存。';
  if (action === 'save' && error?.message === 'RESEARCH_TOOLS_HARD_CAP_REQUIRED') return '有供应商还没有登记平台硬上限，不能打开。';
  if (action === 'save' && code === 'BAD_REQUEST') return '设置内容不符合要求（平台、线路或上限有误），没有保存。';
  return action === 'read' ? '暂时无法读取联网搜索设置，请稍后重试。' : '保存失败，请重新读取后再试。';
}

export function sourceLabel(source: ResearchToolsView['source']) {
  if (source === 'default') return '还没有配置过：联网搜索全部关闭。';
  if (source === 'invalid') return '已存的设置有问题：联网搜索已全部关闭，保存一次正确的设置即可恢复。';
  return null;
}
